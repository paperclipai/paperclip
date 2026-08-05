---
name: escalate-platform-work-to-tsmc
description: >
  Scope rule for non-TSMC companies: build YOUR product on Paperclip, but do not modify
  Paperclip the platform. If a task requires changing the platform itself, stop and escalate
  to TSMC (Mission Control). Use on any task that drifts toward platform/runtime/skill-infra
  changes.
---

# Platform work → escalate to TSMC

Your company builds its own product **on** Paperclip. TSMC owns Paperclip the platform.

## Don't do platform work
Do **not** modify Paperclip itself — the agent runtime, heartbeat, adapters, server, schema,
plugins, the shared `paperclipai/paperclip/*` skills, or the benchmark / skill infrastructure.
If a task needs any of that, **stop and raise it with TSMC / Mission Control** (open an issue
or directive to TSMC and link exactly what you need) rather than changing the platform yourself.

## What you CAN do
- Build and ship your own product (trading bot, sites, books, media, recruitment, etc.).
- **Create and manage your own company's agents** — spin up sisters and role agents with
  `paperclip-create-agent`. That's yours.
- Create **company-specific** skills for your own domain (`company/<id>/<slug>`).

Rule of thumb: building *on* Paperclip is yours; changing *Paperclip* is TSMC's.

<!-- FLEET-CLASS-FIX-2026-08-05 -->
## Fleet-class fixes: local fix + TSMC card, by default (operator ruling 2026-08-05)

The scope rule above says do not MODIFY the platform. This rule is its twin for defects you
fix inside your own company: if the defect's CLASS plausibly exists in other OpCos (shared
adapter failure modes, static-assignee dispatch configs, guard behaviours, poller patterns,
platform-surface quirks), filing a TSMC card is PART OF YOUR FIX — same session, not later.
Describe the class (not just your instance), attach your local fix as the template, and the
card MUST carry an assignee (an unowned backlog card is invisible — proven same day).
TSMC dedupes overlapping cards and standardises the fix portfolio-wide. Reference the TSMC
card id in your closing comment. Canonical process: TSKB0385.