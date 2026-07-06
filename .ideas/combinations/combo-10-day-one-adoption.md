# Combo 10 — Day-One Adoption Kit

**Combines:** 039 Guided Onboarding & Runnable Demo Company · 018 Company Blueprint Library ·
004 Company Dry-Run Estimator · 064 Data Import / Migration · 058 Work Templates & Definition-of-Done

## The unified idea

Paperclip is powerful but conceptually dense, and a new user lands on an empty instance with a blank
"create your first company" and no path to value. Five ideas combine into one **adoption kit** that
takes a cold install to a running company doing the operator's *real* work — fast, safe, and with
eyes open — by reusing one shared substrate: the company-portability serializer as both template
format and import target, plus a `planOnly`/dry-run preview before anything goes live.

- **A guided "aha" in minutes (039).** A one-click runnable demo company (a pre-built org, sample
  goal, starter issues, budget) defaulting to a **free local model** (combo 02 / idea 008) or a
  stubbed adapter so it costs ~nothing and needs no API key, plus an interactive tour anchored to the
  live, moving demo — watch an agent's heartbeat, an issue move, an approval — then "now create your
  real company."
- **Parameterized blueprints (018).** The demo is just one entry in a blueprint library: curated,
  *parameterized* company templates ("SaaS startup," "content agency," "research lab") built on the
  portability format with declared variables (goal, budget, adapter/model per role, team size),
  instantiated by a wizard. Swap the whole org from Claude Code to a local LLM at instantiation.
- **Launch with eyes open (004).** The wizard automatically runs the Dry-Run Estimator: static checks
  (unreachable tasks, budgets that can't cover one run, missing secrets, circular reporting) plus a
  projected cost band and concurrency profile — a preflight before "hit go." (The `planOnly` adapter
  contract here is the same one combos 06/07 need.)
- **Bring your real backlog (064).** Importers per source (Jira, Linear, Asana, GitHub Issues,
  Trello, CSV — via plugins) mapping issues/epics/statuses into Paperclip's model, with a human→agent
  assignee mapping step (unmapped roles can auto-open a job posting, combo 07), and a dry-run preview
  + atomic, snapshot-backed (combo 09) import. Seeing *their own work* running on day one is the
  fastest path to value.
- **Consistent quality from the start (058).** Work templates per type (`feature`, `bug`, `content`,
  `research`) with acceptance criteria + a definition-of-done checklist that becomes the review gate's
  concrete bar (combo 05) and travels with blueprints/exports — so imported and templated work starts
  complete and consistent.

## Why combining wins

These all ride the same rails: blueprints (018), the demo (039), and import (064) all read/write
through the portability serializer; the demo *is* a blueprint; the wizard, the estimator (004), and
import all use the same dry-run/preview philosophy and `planOnly` contract; DoD templates (058) ship
*inside* blueprints. Build the template/instantiate/preview substrate once and all five features are
views on it — versus five separate onboarding surfaces with five different "create a company" paths.

## Phasing

1. Dry-Run Estimator static checks (004) — useful immediately, standalone.
2. Blueprint format + instantiation wizard (018) + work templates/DoD (058).
3. Guided onboarding + runnable demo company on a blueprint (039).
4. Data import: CSV + one high-demand source first, then more (064); cost projection + shadow-heartbeat
   tier of the estimator (004).

## Ratings

- **Difficulty:** Medium — mostly product/UX and field-mapping over an existing serializer; the fiddly
  parts are faithful hierarchy/status mapping across foreign PM tools, the human→agent assignee gap,
  idempotent re-import, keeping the tour in sync with the product, and a genuinely safe sandbox demo.
- **Estimated time to complete:** ~4–6 engineer-weeks.
- **Importance:** 8/10 — every other idea is academic if new users never reach value; this is the
  conversion funnel and the lowest-friction wedge into real adoption.
