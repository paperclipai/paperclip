# 039 — Guided Onboarding & Runnable Demo Company

## Suggestion

Paperclip is powerful but conceptually dense: companies, org charts, adapters, heartbeats,
budgets, governance, goal trees. A new user lands on an empty instance facing a blank-slate
"create your first company" with no obvious path to value — and the fastest way to *understand*
an autonomous company is to *watch one run*, not to read docs and configure adapters first. The
repo ships onboarding assets (`onboarding-assets/ceo`, `onboarding-assets/default`) and
`default-agent-instructions.ts`, so the raw material exists, but there's no **guided first-run
experience** that turns a cold install into an "aha" in minutes.

Add **guided onboarding with a runnable demo company**: a one-click sample company that's already
wired up, plus an interactive tour that explains each concept against something real and moving.

## How it could be achieved

1. **One-click demo company.** Ship a Company Blueprint (idea 018) — a pre-built org (CEO + a few
   reports), a sample goal, starter issues, and a budget — that instantiates from the existing
   onboarding assets. Default it to a **local LLM** (idea 008) or a safe stubbed adapter so the
   demo costs ~nothing and needs no API key to explore.
2. **Interactive tour.** A guided overlay walks the new concepts in order — goal → org chart →
   an agent's heartbeat → an issue moving → budget/spend → an approval — anchored to the live
   demo company so each idea is shown, not just told.
3. **Safe sandbox.** Run the demo in a clearly-labeled mode where actions are contained (no real
   external side effects), so a newcomer can hit "go," watch agents pick up work, and approve
   something without fear.
4. **Graduation path.** End the tour with "now create your real company," carrying lessons
   forward and pre-filling sensible defaults — and offer the Dry-Run Estimator (idea 004) so
   their first real company launches with eyes open.
5. **Re-runnable.** Keep the demo available (not just first-launch) as a living reference and a
   place to safely try features before using them in production.

## Perceived complexity

**Low–Medium.** Most ingredients exist — onboarding assets, default instructions, and (with the
blueprint library, idea 018) a clean instantiation path. The work is product/UX: authoring the
guided tour, packaging a genuinely illustrative demo company, and a contained sandbox mode so the
demo is safe and free to run. The main risk is keeping the tour in sync as the product evolves —
anchor steps to stable concepts/landmarks rather than brittle UI details. High leverage for
adoption relative to effort.
