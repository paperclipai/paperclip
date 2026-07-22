# Skill: EspoCRM context (the revenue system-of-record)
The CRM (EspoCRM) is the single source of truth for the cigar pipeline. Reach it ONLY through the
native CK tools below (if they're in your tool list) — never invent CRM state. Outward sends stay
human-gated regardless of tooling.

## Entities that exist (and what they're for)
- **Account** = the venue (hotel/lounge/shop). The main working table (~180 records).
- **Opportunity** = a real deal on a venue: stage + CHF amount + probability + closeDate. THE pipeline
  object — one per venue deal; update its stage, don't create duplicates.
- **Note** = an activity entry on a record's timeline (research findings, draft summaries). Durable +
  visible in the CRM UI.
- **Contact** = a person at a venue (mostly unused so far; the flat cAnsprechpartner field carries the
  contact person's name today). **Lead** = an unqualified inbound (B2C mostly). **Email** = mail
  synced into the CRM (the reply-detection loop reads this).

## Account fields you should actually read (via espo_get_account)
name · website · emailAddress · phoneNumber · billingAddressState (canton) · billingAddressCity ·
**cAnsprechpartner** (named contact person) · **cKategorie** (lounge/Tabakladen/hotel/…) ·
**cChannel** · **cPrioritaet** (Hoch/Mittel/Niedrig) · **cQuelle** (where the lead came from) ·
industry · type · description · **cVertriebsstatus** (sales status: "Noch offen"=open/uncontacted,
"Kunde"=customer, "In Verhandlung", "Kein Interesse", "Partner", "Konkurrenz").

## CK tools over the CRM (check your own tool list; ask for what you lack)
- `espo_get_account` — full venue record (read this BEFORE researching/drafting; don't re-derive).
- `espo_add_note` — persist a note on the venue's timeline. If it reports mode
  "global-stream-fallback", the note landed in the CRM's global stream (a known permission gap on
  parented posts) — still persisted, mention it and continue.
- `espo_list_emailless` — the enrichment work-list. `espo_set_email` — write a found email
  (own-site-verified only).
- `espo_upsert_opportunity` — create/update the REAL deal record (stage: signal/qualified/contacted/
  replied/booked/proposal/won/lost + amount_chf). `espo_list_opportunities` — read them.
- `espo_forecast` — the ONLY legitimate source of the CHF pipeline number (pure formula from
  Opportunity amount × probability). Never estimate a forecast yourself.
- `espo_pipeline` — status/coverage counts (the manager scoreboard).

## Opportunities auto-write now (2026-07-07) — you rarely create them by hand
The pipeline writes itself deterministically: a real `espo_send_email` moves the venue's Opportunity
to **contacted**; a booked `espo_create_meeting` advances it to **booked** (forward-only, one per
venue, never duplicated). Espo's base currency is **CHF**; `espo_upsert_opportunity` now defaults
`amount` (CK_DEFAULT_DEAL_CHF, 600) + `closeDate` (+90d) so a deal can be created from just
account_id + stage. You still upsert manually for stages the tools don't cover — **replied** (a venue
answered) and **won/lost** (outcome) — via `espo_upsert_opportunity`.

## Rules
- Pipeline truth: prefer Opportunity records for deal state; cVertriebsstatus is the coarse
  venue-level status. When you move a deal forward, both should reflect it (REV-09's job).
- Respect emailAddressIsOptedOut (UWG): never include an opted-out venue in outreach.
- The global metric is commission throughput; a deal that doesn't reconcile to the CRM doesn't exist.

## New tools (2026-07-02): mail + calendar
- `espo_read_emails` — read the ACTUAL inbound mail you must answer (search by sender/subject).
  Never reconstruct a mail from memory.
- `espo_create_meeting` — put a PLANNED slot on Alan's CRM calendar (name, 'YYYY-MM-DD HH:MM' Swiss
  time, account_id). Internal record only — it never emails an invitation; the date PROPOSAL goes in
  the human-approved draft. Bonus: a running bridge syncs CRM Meetings to Alan's Google Calendar/
  TimeTree, so a created meeting reaches his phone.
