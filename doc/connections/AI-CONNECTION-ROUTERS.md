# Experimental AI connection routers

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
model or effort, with a note on fallback, but never the account or harness.
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
