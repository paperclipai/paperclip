# TSR-4723 — Validation gate re-cut (R2 grok-4.5 CV-review adoption)

## Problem
TSR-4709 required shadowing the next 3 real `[PHASE-0-WEDGE]` CV-polish orders. Zero such orders exist (wedge marketing parked; growth experiment blocked). The shadow precondition was **unsatisfiable**, so adoption looked stalled with no named technical blocker.

## Re-cut (effective immediately)
Aligned to TSR-4704 step 2:

1. **Validation gate (runnable now):** run R2 lane on `benchmark/cv-review` dev suite (or representative past cases). Pass if `meanQ(R2) >= meanQ(incumbent same-frame baseline)`.
2. **Live-order shadow gate (later, separate):** TSR-4709 arms when the first real CV-polish order lands. Additive shadow only; never customer-facing. Does **not** block step-2 validation closeout.
3. **Board paid-flip gate:** unchanged. No routing flip without board confirmation.

## Evidence used for this closeout
- R2 meanQ **1.0000** (n=30) — run `probe-20260730-094016`
- Incumbent bare meanQ **0.8974** (n=30) — run `probe-20260730-040556`
- Gate **PASS** (Δ +0.1026)
- Attachment: `meanQ-comparison-R2-vs-incumbent.md` (+ `.json`)

## Next owners after this card
- **TSR-4704:** resume adoption path steps 1/3/4 (lane stand-up if still needed, optional later shadow when orders exist, board flip request). Validation step 2 satisfied by this card.
- **TSR-4709:** remain backlog/todo as later shadow; do not re-block 4704 on zero-order waiting.
