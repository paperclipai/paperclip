# Subscription Window Budgets

## Context

Paperclip has two separate views of provider consumption:

- `cost_events` and `budget_policies` model **money**. A `billed_cents` policy
  sums cost events over a calendar month or the scope lifetime. Crossing the
  limit opens a budget incident, pauses the scope, cancels its runs, and asks
  the Board to raise the budget.
- Provider quota windows model **subscription usage**. The Claude and Codex
  adapters report the provider's own rate-limit windows (a rolling session
  window and a rolling weekly window) as a percent used plus a reset time.
  Subscription runs record `subscription_included` cost events at 0 cents, so
  they never move a money budget.

Operators on a subscription plan have no way to say "leave headroom in my
session window for interactive use" or "stop burning the weekly window on
low-priority agents". The money budget cannot express it, and a money-style
hard stop would be the wrong tool anyway: a subscription window resets on its
own, so pausing the scope and asking a human to "raise the budget" would be
noise that also needs a human to undo.

## Model

`budget_policies` gains one metric and two window kinds:

| Field        | New values                              |
| ------------ | --------------------------------------- |
| `metric`     | `subscription_percent`                  |
| `window_kind`| `provider_session`, `provider_week`     |

- `amount` is a whole percent (0–100) of the provider window.
- `provider_session` reads the provider's `five_hour` window and
  `provider_week` reads its `seven_day` window. Windows are matched by a stable
  `key` on `QuotaWindow`, never by display label.
- Scope semantics are unchanged: a company policy applies to every agent, an
  agent policy to that agent, a project policy to runs in that project. Each
  agent is measured against its own adapter's provider.
- Two policies on the same scope (session and week) combine as OR: whichever
  window is saturated defers the run, and the wait ends at the latest reset.

No schema migration is needed; both columns are free text.

## Enforcement: defer, never pause

Subscription policies are enforced in exactly one place, `claimQueuedRun`, the
last step before adapter invocation. They do not participate in
`getInvocationBlock`, incidents, approvals, or scope pausing.

When a queued run's provider window is at or above the limit:

- **Timer heartbeats** are skipped quietly (`subscription_window_skipped`),
  exactly like the daily cap: the wake is marked skipped and the next interval
  tries again.
- **Every other wake** keeps its run. The run moves to `scheduled_retry` with
  `scheduled_retry_reason = subscription_window_wait` and
  `scheduled_retry_at = resets_at + 30s` (or a default wait when the provider
  reports no reset). The ordinary due-retry loop promotes it back to `queued`,
  and the gate re-evaluates on the next claim. If the window is still
  saturated the run is deferred again with an incremented attempt.
- The issue keeps its status and assignee, the wake stays queued, and no
  comment, incident, approval, or recovery action is written.

The gate **fails closed under a limit**: when the provider row is missing or
not ok, the window is absent, or it carries no utilization, a run covered by an
active policy is deferred for `PAPERCLIP_SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS`
(default 5 minutes) and re-checked, with `usageUnknown` recorded on the wait
and the timer-skip rule unchanged. Dispatching blind is how a limit gets
busted; an operator who would rather run at their own discretion removes the
limit, and a scope with no active policy is never held. A known saturated
window outranks an unknown one, so the wait ends at the later of the two. The
wait bound below still applies, so a probe that stays broken surfaces as a
cancelled run rather than a silent stall.

Only a broken assumption reaches a human: a run that has been waiting for
longer than `PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_MAX_MS` (default 8 days, one
full weekly window plus a day of margin) since its first consecutive deferral
is cancelled with `subscription_window_wait_exhausted` through the same
pre-invocation path as the daily cap: the wake is settled and immediate
recovery is suppressed, because recovery would only re-queue the work straight
back into this gate. The cancelled run and its idle issue then surface through
the ordinary stale-work checks. The bound is a duration rather than a count of
deferrals: the Claude CLI fallback reports no reset time, so a saturated
weekly window is re-checked every `PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS`
(default 15 minutes) for up to a week, which a small deferral count would
exhaust in hours. Only deferrals by this gate count toward the bound; a run
promoted after workspace-busy, transient, or continuation retries starts a
fresh wait. A reported reset later than the deadline is clamped to it, so a
bogus far-future reset cannot hold a run past the bound either.

## Quota snapshot

`readQuotaSnapshot()` memoizes `fetchAllQuotaWindows()` process-wide with a
TTL (`PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS`, default 120s) and shares one in-flight
fetch between concurrent callers. Provider usage endpoints are rate limited and
the Claude CLI fallback runs a terminal probe, so enforcement never fetches per
dispatch. The same snapshot feeds the budget overview and the
`/costs/quota-windows` endpoint, so a `subscription_percent` policy summary,
the placeholder cards, and the Providers tab all show the same percent used
and the provider's reset time as the window end, and one probe serves every
surface.

The Anthropic OAuth usage endpoint allows about one read per minute per
account, shared with every other client of that account (the Claude Code
`/usage` panel included), and answers 429 with `retry-after: 0` for the rest
of the window. The Claude adapter reports such a read as `rateLimited` and
does not fall back to the CLI `/usage` panel, which reads the same endpoint
and would only spend another request. The reader retries a throttled read
after `PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRY_MS` (default 20s), at most
`PAPERCLIP_QUOTA_SNAPSHOT_THROTTLE_RETRIES` times (default 2) per cycle,
before waiting out the TTL; the cap keeps a sustained throttle from becoming
the retry loop that public reports say can get a token flagged.

Live runs also feed the snapshot. Every Messages API response carries the
subscription window utilization in its rate-limit headers; Claude Code turns
them into a `rate_limit_event`, the Claude ACP bridge forwards that as
`_meta["_claude/rateLimit"]` on a `usage_update`, and the patched `acpx`
runtime keeps it as `rateLimit` on the status event (upstream drops all but
`_meta.usage`). The ACP engine hands it to the host through
`onProviderQuotaObserved`, and the server normalizes it (`rateLimitType` to
the window key, utilization to a percent, `resetsAt` to ISO) and folds it into
the shared snapshot as a fresh row for that provider. Each event describes one
window, the representative claim, so the probe keeps its cadence to fill in the
rest; the harvest just makes the snapshot current between probes and gives a
throttled probe a recent read to fall back on. The first window seen per
process is logged with its raw payload so an operator can confirm the scale.
Only the direct ACP engine path is wired; the runner sidecar passes the field
through but the native runtime does not consume it yet.

Single provider reads fail now and then: the Anthropic usage endpoint is rate
limited and the Claude CLI fallback scrapes a terminal. A failed refresh
therefore keeps the provider's last successful result, marked `stale` and
carrying the new `error`, for up to `PAPERCLIP_QUOTA_SNAPSHOT_MAX_STALE_MS`
(default 10 minutes). Every ok result is stamped with `observedAt`. Past the
bound the provider is reported as unavailable again. A stale result at or
above the limit defers to the reset as a fresh read would. Below the limit it
never clears a run by default: nothing bounds how far usage has moved since
the read, so the run holds for the unknown-usage re-check. An operator may
opt in by setting `PAPERCLIP_SUBSCRIPTION_WINDOW_STALE_READ_MAX_AGE_MS` (unset
or 0 keeps the strict default); a stale read younger than that then clears a
run while it is still under the limit after allowing for drift since it was
taken (`PAPERCLIP_SUBSCRIPTION_WINDOW_USAGE_DRIFT_PERCENT_PER_MINUTE`, default
1, the burn rate observed on a busy session window). The opt-in keeps a
throttled minute from holding every queued run at the cost of dispatching on
a reading up to that age old. The alternative,
treating a failed refresh as unknown for one TTL, made the budget cards flip
between a measured percent and "unavailable" on every blip and, while the gate
still failed open, admitted every queued run for a minute each time.

## UI

The Costs → Budgets tab gains a "Subscription usage limits" section with one
card per window (session, week) for the organization scope. Cards for windows
without a policy are seeded from the live quota snapshot so the operator sees
current usage before choosing a limit. `BudgetPolicyCard` renders
`subscription_percent` policies in percent. Its bar is the whole provider
window (0–100%): the fill is the observed usage, a marker sits at the
configured limit, and usage past the limit is hatched, so "Remaining" reads as
the visible gap between the fill and the marker rather than as a percent of
the limit. Without a limit the bar still shows current usage in a neutral
tone. When no provider reported the window (quota fetch failed, window
missing, or no utilization) the summary carries `usageUnavailable` and the
card shows the usage as unavailable instead of a healthy 0%. Under a limit
that state means the gate is holding new runs, so the card keeps the limit
marker over a hatched track and reads "Runs held"; without a limit it reads
"Unknown". When only the latest read failed the summary carries `usageStale`
and `usageObservedAt`, and the card keeps the last measurement and says how
old it is. The summary also carries `usageHeld`, computed with the gate's own
rule, and the card reads "Runs held" over the hatched track only when that is
true, so the card and the gate never disagree about whether runs are waiting.
Agent and project scoped
subscription policies are created through the existing policies API.

## Follow-ups (not in this change)

- Soft-threshold notifications and attention items for subscription policies,
  reusing `budget_incidents` keyed on the provider window start.
- Per-model windows (`seven_day_sonnet`, `seven_day_opus`).
- Account-aware quota reads when agents use distinct provider logins.
