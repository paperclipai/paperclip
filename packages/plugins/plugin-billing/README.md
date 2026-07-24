# @paperclipai/plugin-billing

Self-contained billing for multi-tenant paperclip instances: flat monthly fee
per company, configurable trial, provider-pluggable checkout with a fully
functional stub provider, and a first-class subscription page. Core knows
nothing about money — the only core touchpoints are generic primitives
(`costs.read`, plugin DB namespace, webhooks, jobs, UI slots, and
`company.standing.write`).

Design spec: `docs/superpowers/specs/2026-07-18-billing-plugin-design.md`.

## How it works

- One `subscriptions` row per company; every state mutation is caused by
  exactly one `billing_events` ledger row (webhook, sweep transition, or admin
  action), so replays are no-ops and history is auditable.
- All lifecycle transitions run through one pure function
  (`src/state-machine.ts: transition`), exhaustively table-tested.
- Enforcement is standing-only: `blocked` stops new runs, reads stay available.
  Uninstalling/disabling the plugin clears its standing rows — billing removal
  instantly unblocks all companies, by design.
- The stub provider POSTs HMAC-signed events to the plugin's own webhook
  endpoint, so dev/CI/self-hosters exercise the entire production path with no
  external account. See `STRIPE_ADAPTER.md` for the future real-money adapter.

## Configuration (instance settings → Plugins → Billing)

| Key | Default | Meaning |
| --- | --- | --- |
| `currency` | `EUR` | ISO code used for all prices |
| `defaultMonthlyPriceCents` | `4900` | flat monthly fee per company |
| `trialDays` | `7` | trial length; `0` disables trials |
| `graceDays` | `7` | grace window; align with provider dunning |
| `trialPolicy` | `first-company-per-owner` | or `every-company` / `none` |
| `provider` | `stub` | `stripe` arrives with the adapter |
| `instanceBaseUrl` | `http://127.0.0.1:3100` | where the stub posts its webhooks |

Per-company price overrides (including `0` = complimentary) live on the
instance admin page (Settings → Plugins → Billing).

## Ownership transfer (v1 policy)

Billing stays with the original payer until they cancel; the new owner then
subscribes. No silent card switching (spec §6.2).

## Rollout

1. Bundled but not auto-installed; an instance installs it from the bundled
   plugins list.
2. Fork migration for existing control-plane-billed companies (seeding
   `subscriptions` rows before enforcement cutover) is tracked as its own
   follow-up — deliberately not part of this plugin's v1.
3. Offered upstream once the settings-visibility primitives (PR-1/2/3) land.
