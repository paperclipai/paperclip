# 033 — Stakeholder Transparency Page

## Suggestion

An autonomous company has stakeholders who aren't operators — investors, partners, a parent
org, teammates — who want to know "how's it going?" without being handed full board access (and
its mutation powers, costs, secrets, and noise). Paperclip already has the building blocks for
controlled external sharing (`feedback.ts` manages `feedbackExports`; `company_skills` carries a
`publicShareToken`), but there's no **read-only, shareable company progress view** for outside
stakeholders. Today the choice is binary: full access or nothing.

Add a **stakeholder transparency page**: a curated, read-only, link-shareable snapshot of a
company's health — goal progress, key metrics, recent shipped outcomes — that an operator can
hand to an investor or partner.

## How it could be achieved

1. **Tokenized read-only view.** Reuse the `publicShareToken` pattern: a signed, revocable link
   that renders a fixed, read-only page scoped to one company — no auth into the real board, no
   write paths, no agent internals.
2. **Curate what's shown.** Operator-selected metrics: goal progress (and MRR/P&L once revenue
   tracking lands, idea 030), milestones hit, headline shipped work products, and an optional
   high-level activity timeline. Explicitly *exclude* spend internals, secrets, raw transcripts,
   and anything sensitive by default.
3. **Generated narrative.** Reuse the operator-digest summarizer (idea 029) to produce an
   investor-readable "state of the company" paragraph, refreshed on a cadence.
4. **Controls.** Expiring links, revical/rotation, optional passphrase, and an access log
   (who/when) written to the audit trail (idea 023) — sharing externally is a governance event.
5. **Portfolio roll-up.** A Holding Company (idea 007) can publish a portfolio-level page across
   its subsidiaries — one link that shows the whole group's trajectory.

## Perceived complexity

**Low–Medium.** The share-token mechanism, the underlying metrics, and (optionally) the digest
narrator already exist, so this is primarily a scoped read-only rendering path plus operator
controls for what's exposed. The real care is on the **security/privacy boundary**: a public
link must be incapable of leaking anything beyond the explicitly curated fields, and revocation
must be instant and reliable — get the default-deny exposure model right before adding niceties.
