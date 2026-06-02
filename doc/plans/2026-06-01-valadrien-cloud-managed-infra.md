# Plan: ValAdrien Cloud — Managed Infrastructure for Companies

**Status:** Phases 0–2 implemented (2026-06-01); backfill migration 0091 added; Phases 3–5 pending
**Owner:** Platform / ValAdrien.DEV operator
**Created:** 2026-06-01
**Related:**
- `doc/plans/2026-06-02-valadrien-cloud-blitz-go-live.md` (blitz go/no-go + hosted URL runbook)
- `doc/plans/2026-05-28-founding-role-instruction-bundles.md` (founding agents)
- `doc/plans/2026-05-28-plugin-openrouter-consult.md` (OpenRouter as a tool)
- `Architecture.md` §13 (Tenancy / ValAdrien.DEV bootstrap)
- `docs/companies/companies-spec.md` (company portability / export)

## Context

ValAdrien.DEV is an operator company that sets up and runs autonomous
AI-agent businesses for clients on ValAdrien OS — think "Lovable Cloud
Services," but for whole agent companies. The operator already owns and
pays for the upstream provider accounts:

- **Vercel** (hosting + AI Gateway)
- **Supabase** (Postgres, auth, storage)
- **Resend** (transactional email)
- **Railway** (long-running services / workers)
- **OpenRouter** (multi-model LLM access)
- **Google Workspace** (email domain)
- A **marketing website** already exists.

During the first real onboarding (company `ValAdrien.DEV`, CEO agent
"Sol"), the CEO correctly decomposed an MVP but then queued **board
approvals to "provision paid services" (Managed Postgres + Resend +
Vercel AI Gateway, and Postgres + email + LLM budget)**. That is the
rational move for a client who will take the project away — but it is
**redundant** when ValAdrien.DEV already provides all of it.

Root cause: the company has no model for "infrastructure is provided by
the operator." The `companies` table only carries identity + budget, and
the founding-agent bundles assume the agent must source its own infra.

## Goal

Introduce a **managed-infra model** ("ValAdrien Cloud") so that, by
default, a company **consumes operator-provided infrastructure as a
metered entitlement** rather than provisioning its own paid accounts. A
client only needs their own provider accounts when the project is
**exported** (BYO). Capture the founder/company context (website, founder
LinkedIn) at onboarding so the first founding agent can learn from what
already exists instead of asking.

## Approved design decisions (2026-06-01)

| Fork | Decision |
| ---- | -------- |
| **Scope now** | Plan doc only. No code in this pass. |
| **Isolation** | **Mixed** — shared, company-scoped resources by default (schema/namespace per company, scoped sub-keys); dedicated sub-resources (own Supabase project, own Vercel project) only when a client pays for it or exports. |
| **Provisioning timing** | **Lazy** — record the entitlement at onboarding; provision the real upstream sub-resource on first use by an agent. |
| **Onboarding fields** | First-class `website_url` + `founder_url` columns on `companies`. Validation/enrichment runs during onboarding, performed by the first founding agent (CEO / Chief of Staff / CTO) while it sets up the environment. |
| **Default vs BYO** | Managed (operator-provided) is the default. BYO/own-accounts is the **export** path only. |

## Mental model

```
┌──────────────────────────── ValAdrien.DEV (operator) ────────────────────────────┐
│  Instance-level PROVIDER POOL  (master credentials, operator-owned & paid)        │
│   Vercel · Supabase · Resend · Railway · OpenRouter · Google Workspace domain     │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │  carve company-scoped sub-resource  (lazy, on first use)
                ▼
┌──────────────────────────── Company: client-A ──────────────────────────────────┐
│  ENTITLEMENTS (recorded at onboarding)        ENVIRONMENT + SECRET BINDINGS       │
│   • postgres  → shared Supabase, schema=clientA   (filled lazily on first use)    │
│   • email     → Resend subdomain clientA.<domain>                                 │
│   • llm       → OpenRouter sub-key (budget-capped)                                │
│   • hosting   → Vercel project (dedicated on upgrade/export)                       │
│  METERED into company budget (cost_events / budget_policies)                       │
└───────────────────────────────────────────────────────────────────────────────────┘
                │  EXPORT  →  rotate / migrate creds into client's own accounts (BYO)
                ▼
        Company portability bundle  +  credential handover
```

## How this reuses existing primitives (not a rewrite)

| Need | Existing primitive | Change |
| ---- | ------------------ | ------ |
| Where code runs | `environments` (driver `local`/`ssh`/`sandbox`/`plugin`) | Seed a managed environment per company; add a `managed` marker in `config`/`metadata`. |
| Credentials | `company_secret_provider_configs` + `company_secrets` + `company_secret_bindings` + `*_versions` | Sub-keys carved from the pool land here on first use. |
| Runtime services | `workspace_runtime_services` | Railway/Vercel services attach here. |
| Plugin-owned resources | `plugin_managed_resources` | Provisioning adapters (Supabase/Vercel/etc.) can be plugins. |
| Spend back-pressure | `budget_policies` + `cost_events` + `finance_events` | Metered usage flows into the company budget envelope. |
| Export | company portability bundle (`docs/companies/companies-spec.md`) | Extend to migrate/rotate creds to client accounts. |

The genuinely new pieces are: (1) an **instance-level provider pool**,
(2) a per-service **provisioning adapter** that carves a scoped
sub-resource, and (3) a company **entitlement** record that says "this
capability is provided; here's the binding once realized."

## Scope

### Phase 0 — Near-term truth fix (small, unblocks the wrong approvals)
> Not in this plan's code freeze, but the first thing to ship after the plan is approved.

1. Update the CEO (and, per the founding-bundles plan, CoS/CTO) instruction
   bundle: "When this company is **ValAdrien.DEV-managed**, infrastructure
   (Postgres, email, LLM gateway, hosting) is **provided** — consume the
   environment that is already wired; do **not** open board approvals to
   provision Vercel/Supabase/Resend/Railway/OpenRouter. Open a budget
   envelope approval instead."
2. Resolve/withdraw the two stale "provision paid services" approvals on
   the live ValAdrien.DEV company.

### Phase 1 — Onboarding context fields
1. Add first-class columns to `companies`:
   - `website_url text` (company marketing site, nullable)
   - `founder_url text` (founder/client LinkedIn or profile, nullable)
2. Wire contracts end-to-end:
   - `packages/db` schema + migration (`pnpm db:generate`)
   - `packages/shared` types + Zod validators (URL shape, optional)
   - `server` company create/update routes
   - `ui` OnboardingWizard step 1 adds two optional inputs under
     "Existing repo": **Website** and **Founder LinkedIn**.
3. Thread both into the **first founding agent's** first-issue context so
   the Onboarding Specialist skill reads the live site + founder profile
   while setting up the environment (validation/enrichment happens here,
   per the decision — the agent verifies the URLs resolve and summarizes
   what it learned into the company description / first issue).

### Phase 2 — Entitlement + environment model (managed default)
1. New `company_infra_entitlements` (or reuse `plugin_managed_resources`
   shape) recording, per company: capability (`postgres`/`email`/`llm`/
   `hosting`/`worker`), mode (`managed_shared`/`managed_dedicated`/`byo`),
   status (`entitled`/`provisioned`/`exported`), and the realized binding
   reference (FK into `company_secret_bindings` / `workspace_runtime_services`).
2. A `managed: true` company flag (or `companies.infra_mode` enum:
   `managed` | `byo`) so bundles + UI + approval gates can branch.
3. Onboarding seeds **entitlements only** (lazy): the company is born
   "infra: provided" with nothing provisioned yet.

### Phase 3 — Provisioning adapters (lazy realization, mixed isolation)
1. A small `InfraProvisioner` interface (mirrors the adapter pattern):
   `entitle()`, `provision(scope)`, `rotate()`, `deprovision()`,
   `export(target)`.
2. Per-provider implementations, shared-scoped by default:
   - **Supabase**: shared project, schema/namespace per company (dedicated
     project on upgrade/export).
   - **Resend**: subdomain per company under the operator domain.
   - **OpenRouter**: budget-capped sub-key per company.
   - **Vercel**: dedicated project (cheap to isolate; do per company).
   - **Railway**: service per company (or shared with scoping).
3. First-use trigger: when an agent requests a capability that is
   `entitled` but not `provisioned`, the host realizes the sub-resource,
   writes the secret binding, flips status to `provisioned`, and meters it.

### Phase 4 — Budget envelope replaces per-service approval
1. The board approval flips from "approve provisioning paid Postgres" to a
   single **company budget envelope** approval (one recurring number).
2. Provisioning within the envelope is automatic; crossing it triggers the
   existing budget hard-stop / incident flow.

### Phase 5 — Export (BYO handover)
1. Extend company portability: on export, the operator either migrates the
   company's data into the **client's own** accounts or hands over a
   portable bundle plus rotated credentials.
2. Flip entitlement mode to `byo`; future provisioning targets client
   accounts.

## Non-Goals

- Building a billing/invoicing system for clients (metering into the
  existing budget is enough for v1).
- Real-time multi-cloud cost reconciliation. v1 meters approximately via
  `cost_events`.
- Replacing the secret-provider system. We build **on** it.
- Auto-dedicating resources without an explicit upgrade/export trigger.

## Acceptance

- A ValAdrien.DEV-managed company can be onboarded and its founding agent
  **does not** open approvals to provision Vercel/Supabase/Resend/Railway/
  OpenRouter; it consumes the provided environment.
- `companies.website_url` + `companies.founder_url` round-trip through
  db → shared → server → ui, are optional, URL-validated, and surfaced to
  the first founding agent's first issue.
- A capability marked `entitled` provisions a real (shared-scoped)
  sub-resource on first use and writes a usable secret binding.
- Export flips a company to `byo` and rotates/migrates credentials.
- Budget envelope approval supersedes per-service provisioning approvals
  for managed companies.

## Open questions

1. **`infra_mode` granularity** — one company-level mode, or per-capability
   mode (e.g., DB managed-shared but hosting dedicated)? The mixed-isolation
   decision implies **per-capability** mode lives on the entitlement row,
   with a company-level default. Confirm.
2. **Sub-key support** — verify each provider supports native scoped
   sub-credentials (OpenRouter sub-keys: yes; Supabase: project/service-role
   scoping; Resend: domain-scoped keys; Vercel/Railway: project/team tokens).
   Where native scoping is missing, fall back to dedicated.
3. **Who provisions** — host-side service vs. a provisioning **plugin** per
   provider (`plugin_managed_resources` suggests plugins). Leaning plugin so
   providers stay out of core, consistent with the externalized-adapter
   philosophy.
4. **Marketing-site/LinkedIn fetching** — does the founding agent fetch
   these via an existing browser/fetch tool, or do we need a small
   enrichment tool? (Ties into the Perplexity-agent / OpenRouter-tool plans.)
5. **ValAdrien.DEV as its own first client** — the operator company is also
   managed by itself. Confirm the operator's pool credentials live at
   instance scope (not inside the ValAdrien.DEV company), so the company
   row stays a normal tenant.

## Legacy `mgmt-os-shared` capability mapping (reference only)

Salvage inventory from the old `ValDola-stack/management-os` fork maps
**environment variable names** (never commit values) to ValAdrien Cloud
entitlements. Canonical provider slugs live in
`MANAGED_INFRA_CAPABILITY_PROVIDERS` (`packages/shared/src/constants.ts`).

| Legacy env keys (names only) | Entitlement `capability` | Provider slug | Notes |
| ---------------------------- | ------------------------ | ------------- | ----- |
| `SUPABASE_*` | `postgres` | `supabase` | Shared pool project; company-scoped schema/RLS at provision time |
| `RESEND_*`, `DIGEST_FROM_EMAIL` | `email` | `resend` | Shared Resend account; subdomain or scoped key per company |
| `OPENROUTER_API_KEY` | `llm` | `openrouter` | Sub-key with budget cap; distinct from adapter-level model keys |
| `VERCEL_*` (legacy project id) | `hosting` | `vercel` | Default `managed_dedicated` per company project |
| `RAILWAY_TOKEN` | `worker` | `railway` | Long-running services / workers |

**Not infra entitlements** (adapter / agent layer, not operator pool):

- `ANTHROPIC_*`, `GEMINI_*`, `PERPLEXITY_*` — model adapters, billed via agent runs

**Backfill:** migration `0091_backfill_managed_infra_entitlements.sql` seeds
the default entitlement set for any `infra_mode = 'managed'` company that
predates migration 0090 (e.g. existing ValAdrien.DEV). New companies still
seed at create time in `companyService.create`.
