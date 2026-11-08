# Experimental AI connection routers

The built-in **Ordered failover pool** is available without a router plugin or
the experimental router flag. It is configured with existing AI connections,
ordered by preference and bound to a Paperclip Runner or a supported local agent.
Local Claude, Codex, Grok, and OpenCode agents can use mixed-provider pools.
Each run records its effective adapter without changing the agent's primary adapter. On a confirmed
account allowance exhaustion, Paperclip records a company-scoped cooldown for
the credential and skips it until its reset time. A known provider reset is
preserved; without one the default quota cooldown is two hours. Authentication
failures also cool down the failed credential; reconnecting changes its identity.
A confirmed definitive runner failure uses a five-minute cooldown. Accounts sharing the
same stored credential and epoch share a cooldown. Independently stored
credentials are not assumed to represent the same external account.

Provider changes must preserve the configured execution policy. Incompatible
CLI permission flags and custom command wrappers are rejected before selection.
Explicit CLI/ACP engine choices remain in place for compatible local Claude and
Codex changes. A legacy CLI agent with filesystem or network restrictions cannot switch to a harness that does not enforce the same local process sandbox.

Before selecting an account for a task without an existing pin, the host may
read the responsible user's authorized Claude subscription usage. When an
account-wide limit is exhausted, extra usage is disabled, and the provider gives
a future reset, it records the cooldown and tries the next account. Unknown or
scoped limits, missing authorization and unsuccessful usage checks do not block
selection. This observation is a momentary preflight; it cannot guarantee that
capacity remains available when the provider starts. Existing task pins are not
changed by this check.

Before a fresh provider start, the host rechecks the pinned account's global and
scoped cooldowns. A concurrent cooldown defers fresh work without changing an
already admitted native session. Temporary database contention leaves replacement
pending for the existing recovery scheduler; it is not a permanent refusal.

Legacy provider quota or authentication text can come from model or tool output.
It cannot by itself write an account-wide cooldown, authorize failover, or mark
a pooled credential unusable through automatic authentication repair. For saved
Claude and Codex subscriptions, quota attribution requires account-wide exhaustion
through the saved account's authenticated usage endpoint. Claude must have extra
usage disabled; Codex must deny account-wide admission without available or
unlimited credits. Authentication attribution requires an actual HTTP 401 from
that saved credential's fixed provider endpoint. Local credential parsing failures,
network errors and permission-denied responses do not count as that observation.
The host rechecks the credential epoch before committing attribution. Only quota
uses an observed reset; authentication waits two hours and runner faults five
minutes, ignoring model-visible reset hints. Unsupported or inconclusive evidence
keeps the failed turn held. Historical legacy quota/auth receipts without the
corresponding account evidence cannot authorize a new pin transition. Saved
workspace and session evidence remain available. Codex panic text without an
actual host crash signal may enter its existing bounded same-account retry, but
cannot cool an account or select a backup.

Healthy tasks stay on their selected account, including after a backup takes over.
When a conversation fails because of quota, authentication, or confirmed runner
failure, Paperclip can select the next available account after the previous
execution and local workspace cleanup have settled. The task pin and successor
run commit together. Stop is serialized with successor creation. Ordinary task
errors do not trigger a provider change. If all eligible accounts are cooling
down, the successor waits for the earliest reset instead of probing them repeatedly.

An automatic continuation must prove that the prior execution is stopped and
that the workspace and history are preserved. Known unfinished external changes
retain their reconciliation requirement. Completed actions enter the new conversation
as evidence, never as tool calls to replay. When the required
evidence is unavailable, the task remains held for recovery. A provider switch
starts a separate provider conversation with bounded Paperclip task history;
provider-private conversation state and full tool history are not transferred.
The task's existing account sessions remain isolated by credential identity.
Background runs without an issue retain their original pool affinity and receive
a bounded, untrusted progress handoff. They do not reuse another provider's
agent-wide session. Stop also fences these background successors.

AI routers are virtual, company-scoped connections owned by a capability-gated
plugin (`ai.connections.route`). The instance flag `enableAiConnectionRouters`
defaults to false. Pools also default to disabled. The host must implement this
contract; the plugin's minimum version alone does not establish compatibility.
Routing has no visible enable control in Experimental settings on either
self-hosted or Cloud instances, even after an operator enables it. Self-hosted
operators can set `enableAiConnectionRouters` through the instance-admin
`PATCH /api/instance/settings/experimental` API. Cloud operators use the existing
fleet or per-stack managed feature configuration. Installing a plugin does not
enable routing; enabling routing does not enable individual pools.

The host authorizes members using the ordinary company, user, sharing, install,
health and harness checks. Saving a binding or changing its harness requires
at least one usable member for that agent. New-agent creation installs only
members authorized by the ordinary personal-owner or shared-install policy,
in the same transaction as the agent. Pool membership cannot install a
restricted shared connection. It sends authorized metadata and sanitized usage
observations to `onRouteAiConnection`. The plugin proposes an opaque member ID;
it cannot receive credentials or expand authorization. Pure round robin does
not probe usage. Usage-aware selection has a shared 15-second probe budget,
60-second freshness cache and ordinary grant/secret freshness invalidation.
Concurrent starts share an in-flight probe for the same grant and credential
freshness. Each caller retains its selection deadline.

One cursor spans all agents in a pool. An allocation transaction locks the
cursor, checks config and cursor revisions, rechecks authorization, and writes
the task pin and cursor advance together. Pins use company, pool, agent and the
existing task key (including `__heartbeat__`). Wakes without a task key retain
the original run ID as an affinity key in retry context. Conflicts retry at most
20 times; contention beyond that returns an actionable conflict.

Pins snapshot the concrete binding and member profile. Removing or editing a
member affects future allocations. Composer changes can change a supported
model or effort, with a note on fallback. Only an admitted pool failover can
change the task's account or harness.
Session reset and compaction retain the pin. Revocation requires operator repair.
Authentication repair uses the failed run’s durable concrete allocation and
current member permissions; reconnect-and-continue preserves the agent’s pool
binding. Changing the agent’s pool invalidates the old repair card.
A pre-existing managed session can adopt its saved account when it is an
eligible member; otherwise the operator must explicitly reset the session.

Credential `ai_session_epoch` changes on reconnect or manual rotation. Only
verified runtime refresh write-back preserves it. Session fingerprints use the
secret ID and epoch while authentication failure attribution still uses the
token generation. A reconnect that replaces an indexed legacy secret changes
the session identity even when both secret epochs are zero.
Adopting a valid account preserves a session only when the complete effective
configuration matches a prior fingerprint. Core can bridge binding-only agent
revisions (up to 20) and unchanged legacy token identities at epoch zero. Changes
to other settings, explicit resets, and credential replacement retain their
existing reset behavior; no fingerprint category is exempted.
Native recovery retains concrete routing evidence and can finish after the
router flag or plugin is disabled or uninstalled; it revalidates underlying
account access and never makes a new allocation.

The private Cloud plugin owns round-robin and quota policy. Its manifest declares
`aiConnectionRouter: { name, description }` alongside `ai.connections.route`.
Core adds that connector to the regular catalog and hosts its setup and account
management using authenticated, company-scoped pool APIs. No separate plugin
page or sidebar entry is needed. New allocations over
the chosen threshold wait; known exhaustion defers pinned turns. The deferred
run schedules `ai_connection_pool_wait` without spending the failure retry
budget, and the UI labels that retry as **Pool exhausted**.

Operators choose **Connectors → AI connection pool → Add connection pool**,
select existing accounts, arrange their order, and create a paused connection.
The normal account page supports rename, member changes, enabling, and removal.
**Used by** lists the company’s non-terminated agents configured to use the pool,
with their avatars and links to their profiles. Paused agents remain listed.
Optional usage and runtime defaults live under **Advanced**. Creating another
account opens the normal catalog in a new tab so the pool draft stays intact.
The catalog marks experimental-disabled or unavailable plugins as unavailable.

Deletion uses
`DELETE /api/companies/:companyId/ai-connection-pools/:poolId` with the current
`expectedRevision`. Core disables and archives the virtual connection, retaining
its task pins, cursor and run records. It rejects stale edits and new allocations;
already admitted runs keep their concrete recovery evidence. Cleanup remains
available when experimental routing or the plugin is disabled. The catalog captures the reviewed pool revision before showing its removal
confirmation and uses the pool endpoint. Ordinary connection update and removal
endpoints reject pools so they cannot bypass configuration revisions. Non-managers
see the permission requirement without making a denied management request.

Configuration and committed selection are recorded in activity records. Runs
record the selected member/profile and override notes in the local run log and
recovery context. These records stay in the instance database.

Tests: `cd server && pnpm exec vitest run src/__tests__/ai-connection-router.test.ts`
plus the existing AI connection, retry accounting, run-dispatch and UI suites.

## UI review in Storybook

Run `pnpm --filter @paperclipai/ui storybook` from Core, then open
**AI Connections / Connection pools**. The 16 stories use production components
for pool selection, legacy-session adoption, unavailable/read-only selections,
mixed-provider composer models and effort, mobile composer settings, usage waits,
run selections and override notes, and scheduled retries.
`AllCoreSurfaces` provides an overview; individual stories expose the expanded
menus and adoption dialog. Run `pnpm --filter @paperclipai/ui build-storybook`
to build the preview.

Pool configuration stories belong to the private Cloud plugin's own Storybook
in `extensions/plugin-connection-pool/storybook/`. Both previews use fictional
accounts; they do not call live providers or mutate a Paperclip instance.
Core also owns **Connectors / Pool host** stories for the generic native
extension. The overview links to Cloud's **In Connectors** preview on port 6010;
its stories mount these same production routes, header, sidebar and tokens.
**Full Setup And Management** exercises the complete catalog-to-pool journey.
Both previews include **Operator Setup Required** for a manually disabled host.

## Full-app browser acceptance

Install the compatible plugin into an isolated, loopback `local_trusted` instance,
enable the experimental flag, and use a company named for an E2E or test drive
with two saved, authorized AI accounts. Run:

```sh
PAPERCLIP_CONNECTION_POOL_E2E=1 \
AI_CONNECTIONS_TEST_URL=http://127.0.0.1:3100 \
AI_CONNECTIONS_TEST_COMPANY_ID=<test-company-id> \
pnpm exec playwright test --config tests/ai-connections-app/playwright.config.ts connection-pools.spec.ts
```

These opt-in tests exercise the shipped app, installed plugin and database without
mocking browser routes or pool APIs. They cover catalog navigation, setup, ordering,
paused defaults, rename, member changes, refresh persistence, stale edits and
removal. They verify that an operator-enabled host still offers no Experimental
control for routing. With a test agent already bound to a saved pool, they also verify
the **Used by** list, avatars and profile links. Cleanup archives only the test's own pool and verifies that existing
accounts and pools remain intact. This suite does not execute agents or probe
live usage; provider and restart acceptance remain separate gated test drives.


## Central harness pools

Settings → Connections → Harness pools manages shared, company-scoped pools.
Smart, Mid and Cheap are editable starting names, not fixed model tiers. Add as
many ordered members as needed (up to 100). Each member chooses its own saved
account grant, concrete harness, model ID and optional effort. The same account
can appear with different models. No credentials are copied into the pool.
Saving validates model IDs against the saved connection's routing catalog or
the supported harness catalog. OpenRouter members use its public catalog.

On an agent's Harness / Runtime settings, choose **Harness: Pool**, then the
central pool. This explicitly uses **Paperclip Runner** and requires the existing
Native Runner experiment to be enabled by the operator. Pool selection does not
enable that setting or upgrade Legacy agents. Use the existing Runner upgrade
action before selecting Pool on a Legacy agent. New agent setup offers a held
Pool choice and tests it before the normal hiring/approval action. Several agents can choose the same pool; changing one
agent's selection does not change the others. Instructions, permissions and the
execution environment belong to the agent and remain admission constraints.
Models and accounts belong to the pool. Pool runs require a task.
The selected execution environment must also support native Runner execution.
Windows native agent qualification remains deferred; a successful Windows
Runner build does not qualify agent execution. See the
[Runner platform notes](../../packages/paperclip-runner/README.md).

The host freezes the concrete driver profile, pool name/revision and selected
member before claim. It uses the existing Codex, Claude/Grok ACPX or OpenCode
driver, with one native run owner. Pool is not another model API, Rust provider,
CLI wrapper process or nested agent loop. Existing direct/Legacy configurations
and old run snapshots keep their original readers. The optional
`runtimeConfig.harnessPool: { poolId }` conflicts with a direct `aiConnection`.

A healthy task keeps its pinned member. Confirmed usage/authentication failures
hold the credential across models and agents; the provider reset deadline wins,
otherwise the hold is two hours. Definitive stopped-runner failures hold the
credential/harness/environment combination for five minutes. New credential
epochs do not inherit old cooldowns. Unsupported or uncertain failures retain the
existing recovery hold. All-cooling work waits for the earliest deadline or a
real configuration/reconnect event, without trying a blocked provider repeatedly.

A supported transition admits one linked successor after the existing settlement,
Stop, task ownership, budget, permission and workspace checks. It retains the
workspace and bounded task handoff. It starts a fresh provider conversation when
necessary; it does not copy private Claude/Codex sessions or replay completed or
uncertain tool calls. Historical failures can still record a verified cooldown
after an agent changes pools. That receipt cannot authorize a new successor.

Existing built-in ordered pools offer **Preview conversion** and an explicit
**Convert pool** action. Conversion preserves the ID, order and historical pins;
it does not upgrade agents or change an active run. Plugin-owned routers cannot
be converted. Archive explains that new work needs another pool; historical
receipts remain readable. Edits and archive use the existing revision checks.

The `/companies/:companyId/harness-pools` management API shares the existing
connection permissions, company boundaries, audit log, pool storage and cursor.
Its inspection returns visible member status/account deadlines and referencing
agents. Runner eligibility also depends on each task's environment and policy.
The separate `/harness-pools/choices` endpoint returns only authorized pool
IDs, names, revisions and enabled state for agent selection. It does not expose
managed member/account details. Archive requires a successful affected-agent
inspection in the editor.
Legacy pool listings exclude V2 records. Existing OpenAI-compatible gateway
connections remain qualified connection types; installing/managing a proxy is
outside this feature, and hidden upstream accounts are not attributed by Paperclip.
