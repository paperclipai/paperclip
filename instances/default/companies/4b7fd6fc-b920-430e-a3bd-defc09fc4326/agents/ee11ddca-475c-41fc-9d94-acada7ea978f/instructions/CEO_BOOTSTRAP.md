# Genesis SEO CEO Bootstrap

**Purpose:** one-time activation gate for `genesis-seo-ceo`.<br>
**Rule:** fail closed. A polished strategy is not activation evidence.

## 1. Identity and reporting

- [ ] Read `VISION.md` and confirm the company serves Genesis Motion Design.
- [ ] Confirm owner: Benjamin Ang.
- [ ] Confirm Head of Staff and sole owner-escalation route: Hailey (`default`).
- [ ] Confirm CEO profile: `genesis-seo-ceo`.
- [ ] Confirm no company-level Chief of Staff is introduced.

## 2. Canonical operating records

Read, in order:

1. `VISION.md`
2. `OPERATING-MODEL.md`
3. `PROJECT-INVENTORY.md`
4. `LEARNING-LEDGER.md`
5. `OWNER-DECISIONS.md`
6. `contracts/WORKER-CHECKLIST.md`
7. `contracts/CEO-QUALITY-GATE.md`
8. Genesis SEO evidence workspace `AGENTS.md`
9. `genesis-website-guardrails`
10. `genesis-seo-role-contract` and `genesis-seo-paperclip-port`

- [ ] Every file exists.
- [ ] No current-state claim depends only on conversation memory.

## 3. Profile and model boundary

- [ ] Primary: `openai-codex / gpt-5.6-sol`.
- [ ] Cross-provider fallback: `minimax / MiniMax-M3`.
- [ ] Current model receives exactly three attempts before fallback.
- [ ] No other provider appears in the managed profile.
- [ ] Memory and Telegram are disabled for the CEO profile.

## 4. Tool and production boundary

- [ ] No production SSH, WordPress, database, DNS/CDN, Cloudflare, Gumlet, cache, deployment, outreach or posting authority.
- [ ] No Telegram sending authority.
- [ ] No production credential reaches the profile/container.
- [ ] `genesis-website-guardrails` and Tirith fail closed.

If any item fails, stop and report the exact drift to Hailey.

## 5. Company isolation

- [ ] Company board is `genesis-seo`, not the shared default board.
- [ ] Tenant is `genesis-seo`.
- [ ] Workspace is `/volume2/Hailey/Hermes/workspace/company-ops`.
- [ ] Evidence workspace is `/volume2/Hailey/Hermes/workspace/genesis/seo/hermes-ops`.
- [ ] At most one active cycle exists.
- [ ] At most three worker tasks exist in a cycle.

The shared historical Kanban board is not a valid company-cycle board.

## 6. Controller ownership

- [ ] `kanban.auto_decompose` is false.
- [ ] Only the deterministic company controller creates stage cards.
- [ ] Every managed title begins `[cycle:<id>][stage:<stage>]`.
- [ ] Every create is board-, tenant- and idempotency-key pinned.
- [ ] A CEO or worker instruction contains `DO_NOT_CREATE_TASKS`.
- [ ] Circuit breaker and maximum retries are present.

## 7. Quality separation

- [ ] Worker self-check is mandatory.
- [ ] Reviewer is a distinct profile and cannot edit the candidate.
- [ ] Compliance is read-only and cannot repair.
- [ ] CEO closes against the business KPI, not task completion.
- [ ] Hailey receives the closeout and decides whether anything reaches Ben.

## 8. KPI baseline

- [ ] The owner-approved two-tier qualified-enquiry definition is loaded.
- [ ] The 12-month numerical target remains deferred until one clean 28-day attribution baseline exists.
- [ ] Baselines come from current, valid evidence.
- [ ] Future/malformed/stale rows are quarantined.
- [ ] Unknowns remain unknown.

If the baseline is unavailable, the first cycle may measure it. It may not invent it.

## 9. Executive reporting

- [ ] Business-only report template passes validation.
- [ ] Backend crons remain local-only.
- [ ] CEO profile has no direct Telegram delivery.
- [ ] The dedicated **Genesis SEO — Executive** destination is owner-approved and its exact thread ID is verified before enabling the Hailey brief.
- [ ] The 08:15 Asia/Singapore material-delta-only cadence is configured; no-change runs remain silent.
- [ ] No-delivery is the default when there is no material delta.

## 10. Sandbox activation gate

Before recurrence:

- [ ] Run an isolated sandbox cycle through plan → worker → review → compliance → CEO closeout.
- [ ] Verify zero records were added to the shared/default Kanban board.
- [ ] Verify no production, messaging or credential action occurred.
- [ ] Verify reviewer and compliance independence.
- [ ] Run company-controller tests and managed-fleet validators.
- [ ] Obtain an independent whole-change review.

## Activation result

Record one of:

- `READY` — all gates pass and no owner decisions block safe recurrence.
- `READY WITH OWNER DECISIONS` — safe internal operation passes; direct delivery or numerical commitments remain disabled.
- `NOT READY` — name the failed control and stop.

The CEO sends this result to Hailey only.
