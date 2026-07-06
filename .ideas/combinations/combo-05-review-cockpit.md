# Combo 05 — Operator Review & Approval Cockpit

**Combines:** 016 Approval Triage & Policy Batching · 017 Run Change-Review Surface ·
027 Mobile Push & Fast Approvals · 029 Scheduled Operator Digest · 038 Approval Delegation & Coverage
· (publishes via 033 Stakeholder Transparency Page)

## The unified idea

Human approval is Paperclip's governance backbone — and in a 24/7 company the human is the **single
point of stall**: items pile up undifferentiated, the operator can't *see* what a run actually did,
nothing reaches them on their phone, no summary comes to them, and when they're asleep or away the
whole company freezes. Five ideas each fix one link in the *same review pipeline*; combined they are
one **review cockpit** that takes an event from "needs a human" to "decided" as fast and as safely
as possible.

- **Make every item legible (017).** A PR-style change-review surface per run: files added/modified/
  deleted with diffs, commands run, work products — so the reviewer approves *a concrete diff*, not a
  vague "work product." Run-to-run diffing also exposes diminishing-returns loops visually.
- **Rank, group, and auto-handle the long tail (016).** A risk score per approval (acting agent's
  trust stage, implied spend, sensitive-boundary crossings, diff size) drives a triage inbox:
  risk-sorted, grouped (bulk-approve "all 8 doc edits"), with conservative, fully-audited
  auto-approve policies for the low-risk tail.
- **Reach the human anywhere (027).** Web Push / PWA on the *same* signals, gated by the risk score
  so only high-signal events buzz; deep-link straight into a single-item card with the diff (017)
  inline and big approve / reject / request-changes actions reviewable one-handed in ten seconds.
- **Bring the summary to them (029).** A scheduled, narrated digest ("shipped 12 issues ($4.10);
  marketing blocked 2 days; 3 items need you; burn 18% over plan") assembled from existing signals
  on the routine scheduler, led by what needs the human, delivered to inbox / push / email.
- **Keep flow when they're away (038).** Scoped, time-boxed approval delegation to another human or a
  tightly-bounded manager agent, plus SLA coverage routing so unactioned items escalate instead of
  rotting — the human-coverage analog of quiet hours.

The same narration engine that writes the digest (029) also powers a tokenized, read-only
**stakeholder transparency page** (033) for investors/partners — same content, external audience.

## Why combining wins

Every link feeds the next: the risk score (016) decides what's worth a push (027) and what may
delegate (038); the diff surface (017) is the payload of both the inbox card and the push; the digest
(029) is just a scheduled rollup of the same triaged items and the low-effort first slice that proves
the push pipeline. Building them separately yields five inconsistent "approval" experiences; built as
a cockpit they share one risk model, one diff renderer, one notification pipeline, and one audit path.

## Phasing

1. Run change-review diff surface (017) + risk-scored, grouped triage inbox (016) — sorting/grouping
   first (pure upside), auto-approve policies behind narrow explicit rules later.
2. Scheduled digest (029) — proves the delivery pipeline cheaply.
3. Web Push / PWA fast-approval card (027).
4. Delegation + SLA coverage (038); stakeholder page (033) on the digest narrator.

## Ratings

- **Difficulty:** Medium — data and inbox model exist; new surface is Web Push (service worker, VAPID,
  per-user prefs) and the auto-approve/delegation *authority model*, which must be airtight so it can't
  escalate privilege or silently remove the safeguard.
- **Estimated time to complete:** ~4–6 engineer-weeks.
- **Importance:** 9/10 — the human bottleneck is exactly what stalls 24/7 autonomy every evening and
  weekend; this is what makes "manage your companies from your phone" actually true.
