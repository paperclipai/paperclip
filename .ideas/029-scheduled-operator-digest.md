# 029 — Scheduled Operator Digest ("Company Standup")

## Suggestion

To know what happened across an autonomous company, an operator today has to actively go
*looking* — scan the board, the activity log, the cost view, the inbox. There's no **push
summary** that comes to them. For a system whose whole pitch is "agents run 24/7 while you're
away," the missing piece is the morning-after answer to "what did my company do overnight, what
did it cost, and what needs me?" Human teams have standups and status reports; an AI company
should generate its own.

Add a **scheduled operator digest**: a periodic, human-readable summary of each company's
activity — progress, spend, blockers, and decisions awaiting the operator — delivered on a
cadence the operator chooses.

## How it could be achieved

1. **Schedule it natively.** Digests are a natural use of the existing scheduled-routines system
   (`routines.ts`, `plugin-managed-routines.ts`) — "every weekday at 8am," "end of day," etc.
2. **Assemble from existing signals.** Pull from data already tracked: issues opened/closed and
   goal progress (`goals.ts`), spend and burn (`costs.ts`) — including token usage for
   subscription users (idea 019) — top blockers (idea 010), drifted/orphaned work (idea 026), and
   pending approvals (idea 016). No new tracking required, just aggregation.
3. **Narrate it.** Turn the aggregates into a tight, readable brief with a cheap local model
   (idea 008): "Shipped 12 issues ($4.10). Marketing is blocked on the CFO's budget approval (2
   days). 3 items need your sign-off. Burn is trending 18% over plan." Lead with what needs the
   human.
4. **Deliver where the operator is.** Inbox by default; via mobile push / PWA (idea 027) or email
   for the away-from-desk case. Each digest links straight back to the items it mentions.
5. **Per-company + portfolio.** One per company, and a rolled-up portfolio digest for a Holding
   Company operator (idea 007) — "here's all five companies in one note."

## Perceived complexity

**Low–Medium.** This is mostly composition over infrastructure that already exists — scheduling,
the data sources, and (optionally) a local model for narration. No execution-engine changes. The
effort is in selecting the *right* few things to surface (a digest that reports everything
reports nothing) and the writing quality of the summary. It's also a low-risk first slice for the
mobile-push pipeline (idea 027) and a natural consumer of nearly every analyzer idea in this
folder.
