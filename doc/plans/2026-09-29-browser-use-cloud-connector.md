# Browser Use Cloud connector — 2026-09-29

Approved implementation: connect Browser Use Cloud using its v4 REST API and the
normal Access → Connect → Permissions flow. API keys remain in the vault; actions
use the existing governed gateway. Hosted browser tasks are destructive-capable.

2026-09-30 clarification: the app key and runtime skill name are
`browser-use-cloud`. Bundle instructions with the connector implementation,
outside universal `skills/`, and contribute them only with authorized connection
tools in the agent's task run. Remove them when access is revoked. Preserve
pre-release connection and cost records when migrating the old provider key.

Persist company/task/agent/credential-grant ownership, conversation sessions,
individual runs with durable event cursors and accounting checkpoints, and browser
instances separately. Observe browser.ready while work proceeds. Reconcile after
restart; never replay an uncertain paid create. Continue idle conversations with
POST /runs and sessionId. Cancel run and stop browser are separate operations.

Show an interactive Browser tab beside Properties and Artifacts. Auto-open the
arrival of each new session once, respect subsequent navigation and closes, preserve the iframe
across tab switches, and allow reopening through the launcher. Closing a tab only
hides it. Viewer credentials are fetched on demand by authorized humans, never
returned to agents, persisted in tab state, or included in logs or live events.

Completed browsers stay open while viewed, then have a ten-minute idle grace period with Keep open. Task/run
cancellation, reassignment, budget stops, and credential revocation trigger durable
cleanup. Provider expiry wins. Followups use normal task conversations and tools.
Existing profiles are optional, explicitly allowed per credential. Fresh browsers
are the default. Recording and automatic artifact import are deferred.

Enforce v4 maxCostUsd from applicable remaining budgets and configured limits;
account cumulative provider usage idempotently. Verify deterministic transport,
ownership, policy, lifecycle, event recovery, viewer authorization, and UI states;
then verify with a live credential if available. Never claim fixture evidence as
live provider proof.

Sources: https://docs.browser-use.com/cloud/api-v4-overview,
https://docs.browser-use.com/cloud/openapi/v4.json,
https://docs.browser-use.com/cloud/browser/live-preview.
