# TSC 14-day approval-queue batch

Prepared: 2026-08-02 (Europe/Dublin)  
Source tiles: `/Users/glad0s/paperclip/work-products/TSC-7174/` (8 verified files)  
Queue state: **not loaded** — approval-only manifest; no external post is authorised.

## Exact route choice

**Manual bridge, conditional on CEO approval in TSC-7237.** Do not select or substitute an existing non-TSC Postiz integration. If the CEO instead connects a TSC-owned Postiz channel, this batch must be loaded into that exact newly connected integration as **draft / pending approval only**; do not use this manifest to make a channel decision.

The manual bridge is the currently specified fallback because the live ThinkStack MC Postiz inventory has no TSC-routable channel. It remains unapproved until TSC-7237 resolves. TSKB0341 records the verified routing constraint.

## Posting controls

- Cadence: one item per day, 2026-08-03 through 2026-08-16, at 10:30 Europe/Dublin.
- All records must be created as **DRAFT / pending operator approval**, with automatic publishing disabled.
- No item may be submitted, scheduled to publish, or posted externally by this batch.
- Captions are deliberately short and contain no performance figure, return, market prediction, client-result statement, or call to invest.

## Load manifest

| # | Local date / time | Source file | Caption | Required resulting state | Queue ID |
|---:|---|---|---|---|---|
| 1 | 2026-08-03 10:30 | `xai_grok-imagine-image_20260730_171956_9d5b794e.jpg` | ThinkStack Capital. Strategic alpha, built with discipline. | Draft / pending approval | `UNASSIGNED` |
| 2 | 2026-08-04 10:30 | `xai_grok-imagine-image_20260730_172004_d92b4884.jpg` | Clear thinking, deliberate structure, long-term perspective. | Draft / pending approval | `UNASSIGNED` |
| 3 | 2026-08-05 10:30 | `xai_grok-imagine-image_20260730_172012_96959549.jpg` | A considered approach puts risk at the centre of the conversation. | Draft / pending approval | `UNASSIGNED` |
| 4 | 2026-08-06 10:30 | `xai_grok-imagine-image_20260730_172029_ddd8a1ef.jpg` | Layered intelligence. One deliberate point of view. | Draft / pending approval | `UNASSIGNED` |
| 5 | 2026-08-07 10:30 | `xai_grok-imagine-image_20260730_172036_b66c8ddf.jpg` | Institutional-grade thinking, shaped for a changing world. | Draft / pending approval | `UNASSIGNED` |
| 6 | 2026-08-08 10:30 | `xai_grok-imagine-image_20260730_183940_342a5cd0.jpg` | A standard of care that begins with the work. | Draft / pending approval | `UNASSIGNED` |
| 7 | 2026-08-09 10:30 | `xai_grok-imagine-image_20260730_183948_845f14f1.jpg` | Strategic partnerships begin with shared clarity. | Draft / pending approval | `UNASSIGNED` |
| 8 | 2026-08-10 10:30 | `xai_grok-imagine-image_20260730_183955_932826bb.jpg` | Built around what endures: discipline, patience, perspective. | Draft / pending approval | `UNASSIGNED` |
| 9 | 2026-08-11 10:30 | `xai_grok-imagine-image_20260730_171956_9d5b794e.jpg` | A strategic point of view, with the discipline to stay focused. | Draft / pending approval | `UNASSIGNED` |
| 10 | 2026-08-12 10:30 | `xai_grok-imagine-image_20260730_172004_d92b4884.jpg` | The strongest foundations are built deliberately. | Draft / pending approval | `UNASSIGNED` |
| 11 | 2026-08-13 10:30 | `xai_grok-imagine-image_20260730_172012_96959549.jpg` | Thoughtful risk awareness is part of every serious strategy. | Draft / pending approval | `UNASSIGNED` |
| 12 | 2026-08-14 10:30 | `xai_grok-imagine-image_20260730_172029_ddd8a1ef.jpg` | Intelligence becomes useful when it is applied with care. | Draft / pending approval | `UNASSIGNED` |
| 13 | 2026-08-15 10:30 | `xai_grok-imagine-image_20260730_172036_b66c8ddf.jpg` | Built for considered decisions, not noise. | Draft / pending approval | `UNASSIGNED` |
| 14 | 2026-08-16 10:30 | `xai_grok-imagine-image_20260730_183955_932826bb.jpg` | Perspective is a practice. We take it seriously. | Draft / pending approval | `UNASSIGNED` |

## Queue/load instructions for the authorised operator

1. Resolve **TSC-7237** first: either approve the manual bridge, or connect a named TSC-owned integration to ThinkStack MC Postiz.
2. Record the resulting exact route in this document's header and retain the source tile filenames above. For Postiz, capture the integration/channel name and ID; for manual bridge, record the operator and destination account.
3. Create all 14 items as drafts only, preserving the date/time, source file, and caption verbatim. Disable auto-publish and do not click any submit/publish control.
4. Re-read the draft queue, write each resulting queue/draft ID into the final column, and verify there are exactly 14 pending-approval records and zero published records.
5. Post the completed IDs and route evidence back to TSC-7179. Operator approval remains a separate human action; this manifest does not grant it.

## Verification boundary

This package contains 14 planned records and 0 live queue IDs. It is not evidence that a Postiz or manual queue has been loaded. Live staging can only be claimed after the route decision and a re-read of the created drafts.
