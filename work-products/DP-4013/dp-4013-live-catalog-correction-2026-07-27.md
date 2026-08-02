# DP-4013 — Live catalog correction after storefront cleanup

- Date: 2026-07-27
- Source issue: DP-4013
- Related cleanup history: DP-3927, DP-3958

## What changed

On 2026-07-27 the operator removed the remaining old/off-brand DastardlyPrint
listings from Etsy.

The canonical DastardlyPrint storefront state is now:

- the 10 approved first-10 life-admin listings published on 2026-07-24
- no legacy/off-brand listings carried forward beside that approved set

## Verification basis

- The 2026-07-24 publish pass on DP-4013 already produced exact per-listing
  read-back evidence in the issue work products:
  - `DP-4013 Etsy live read-back markdown`
  - `DP-4013 Etsy live read-back JSON`
- The 2026-07-27 storefront change was recorded by the board/operator in the
  DP-4013 thread as the canonical catalog correction.
- A fresh public storefront scrape was not usable from this run because Etsy
  returned its anti-bot interstitial instead of the listing grid.

## Rule for future DP storefront work

Any future DastardlyPrint listing edit, optimization, or catalog operation must
start from this approved ten-listing baseline and must not restore the removed
legacy listings.

If a future task proposes expanding beyond the approved ten, treat that as new
catalog work, not as restoration of historical residue.
