# 005 — Spend-Schedule / Quiet Hours Profiles

## Suggestion

Autonomy is "always on," but an operator's tolerance for spend and concurrency isn't
constant through the day. They may want the company to **run hard overnight** (cheap, nobody
watching, big batch work) and **throttle during the workday** (so they can review output
before more piles up), or pause entirely during a demo. Today the only levers are blunt:
pause an agent or hit the budget wall.

Add **time-based concurrency/spend profiles** — "quiet hours" for an AI company. The
operator defines windows, each with its own concurrency cap and/or burn ceiling, and the
system shifts automatically.

## How it could be achieved

1. **Reuse scheduled routines.** Paperclip already ships first-class scheduling
   (`routines.ts`, `plugin-managed-routines.ts`, cron-style). A spend profile is a routine
   whose action mutates the active concurrency cap / budget pace rather than launching work.
2. **Profile model.** Per company: a list of `{ cronWindow, maxConcurrentRuns, maxBurnPerHour }`.
   At each window boundary, set the company's effective cap (the same value the Fleet
   Concurrency Governor, idea 001, reads).
3. **Default profiles.** Ship presets — "Always full," "Nights & weekends only,"
   "Business-hours throttle," "Paused" — so operators get value without authoring cron.
4. **Manual override.** A one-click "boost for the next 2 hours" and "quiet now" that
   temporarily supersede the schedule, with auto-revert.
5. **Timezone correctness.** Store the operator's tz on the company so windows mean what
   they expect; surface the next transition ("throttles to 4 runs at 9:00am") on the
   dashboard.

## Perceived complexity

**Low–Medium.** This is largely composition of features that already exist: scheduling
infrastructure is built, and it leans on the concurrency-cap setting from idea 001 (so it's
best sequenced after that). The genuinely fiddly bits are timezone/DST handling and clean
interaction with manual overrides and the predictive breaker (idea 002) — they all write the
same effective-cap value, so there must be one clear precedence order (manual > breaker >
schedule). Define that precedence up front.
