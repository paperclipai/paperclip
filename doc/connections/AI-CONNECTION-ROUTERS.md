# Experimental AI connection routers

AI routers are virtual, company-scoped connections owned by a capability-gated
plugin (`ai.connections.route`). The instance flag `enableAiConnectionRouters`
defaults to false. Pools also default to disabled. The host must implement this
contract; the plugin's minimum version alone does not establish compatibility.

The host authorizes members using the ordinary company, user, sharing, install,
health and harness checks. It sends authorized metadata and sanitized usage
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
epoch while authentication failure attribution still uses the token generation.
Adopting a valid account preserves a session only when the complete effective
configuration matches a prior fingerprint. Core can bridge binding-only agent
revisions (up to 20) and unchanged legacy token identities at epoch zero. Changes
to other settings, explicit resets, and credential replacement retain their
existing reset behavior; no fingerprint category is exempted.
Native recovery retains concrete routing evidence and can finish after the
router flag or plugin is disabled or uninstalled; it revalidates underlying
account access and never makes a new allocation.

The private Cloud plugin owns round-robin and quota policy. Its configuration
page uses authenticated, company-scoped Core pool APIs. New allocations over
the chosen threshold wait; known exhaustion defers pinned turns. The deferred
run schedules `ai_connection_pool_wait` without spending the failure retry
budget, and the UI labels that retry as **Pool exhausted**.

Configuration and committed selection are recorded in activity records. Runs
record the selected member/profile and override notes in the local run log and
recovery context. These records stay in the instance database.

Tests: `cd server && pnpm exec vitest run src/__tests__/ai-connection-router.test.ts`
plus the existing AI connection, retry accounting, run-dispatch and UI suites.

## UI review in Storybook

Run `pnpm --filter @paperclipai/ui storybook` from Core, then open
**AI Connections / Connection pools**. The 19 stories use production components
for pool selection, legacy-session adoption, unavailable/read-only selections,
mixed-provider composer models and effort, mobile composer settings, usage waits,
run selections and override notes, scheduled retries, and the experimental flag.
`AllCoreSurfaces` provides an overview; individual stories expose the expanded
menus and adoption dialog. Run `pnpm --filter @paperclipai/ui build-storybook`
to build the preview.

Pool configuration stories belong to the private Cloud plugin's own Storybook
in `extensions/plugin-connection-pool/storybook/`. Both previews use fictional
accounts; they do not call live providers or mutate a Paperclip instance.
