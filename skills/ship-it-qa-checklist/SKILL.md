---
name: ship-it-qa-checklist
description: >
  The last-look QA gate before anything is marked done or sent to the board to publish — any
  deliverable, any company. Use immediately before "done"/"request board publish" on a book,
  listing, site, video, CV, or page. The universal "is this actually shippable" pass.
---

# Ship-It QA Checklist

"Works locally" / "looks fine in the draft" is not done. Most failures are dumb, catchable misses.

## Universal pass (every deliverable)
- [ ] No placeholders / TBDs / lorem ipsum / template tokens left in the final artifact.
- [ ] It actually opens/runs in the real environment the buyer uses (not just our editor).
- [ ] Spelling/grammar/brand names correct everywhere (a misspelled brand kills trust).
- [ ] Numbers right: price, dates, dimensions, counts, contact email — checked, not assumed.
- [ ] Links resolve (no 404s, no localhost/staging URLs, no dead CTAs).
- [ ] Looks intentional on **mobile** (most traffic): web-design-polish + 120px/390px readability check.
- [ ] **For any rendered/deployed page: you've actually SEEN it** — screenshot the live URL via the Playwright MCP (`browser_navigate` → `browser_take_screenshot`; `browser_resize` to 390px for mobile). Never tick "done" on a page you've only read as code.
- [ ] Hash-bound artifacts still match: if a QA report, promote record, manifest, or publish/requeue packet names a SHA-256, recompute the final file hash after QA and cite the matching path. A post-QA overwrite voids the packet.
- [ ] Done comment states the *verification* (counts + live URL/path), not a claim — house standard.

## Domain gates (run the right one)
- **Book** → epubcheck clean (0/0/0) + KDP Previewer first/last-chapter spot-check (kdp-publishing-pipeline).
- **Etsy** → visual-truth gate (dims/ratio/sRGB/mobile), every ZIP/tile/tag present, dry-run N/N ready (etsy-listing-ops). For PDF planners/trackers, also require all-page A4/US Letter render evidence, page-fill/usability sign-off, Dastardly brand check, buyer ZIP manifest, and listing images that match the exact delivered PDFs.
- **Utility site** → smoke checks pass + view-source the deployed URL for title/meta/JSON-LD + Playwright screenshot + a green `npx lighthouse <url>` (CWV = ranking/AdSense) (utility-site-shipping, web-design-polish).
- **Video** → ffprobe matches spec, audio/caption/first-last-frame checks, per-asset licence note (video-gen-ops / video-editing).
- **Video / bench work-products** → final evidence retained, regenerated `work/` folders and per-sample Hermes homes pruned through `~/scripts/paperclip-retention.sh` once safe. Shipping a deliverable must not leave multi-GB temporary scaffolding behind.
- **CV** → PASS QA per delivery SOP, .docx + .pdf both open clean, ATS-safe (recruitment-pipeline-ops).
- **YMYL video** → linter pass + sign-off state machine (content-production-ops).

## Discoverability + conversion (don't ship blind)
- [ ] Metadata/keywords/tags present + chosen, not default (the relevant research skill).
- [ ] Conversion/sale event will be recorded (analytics-finops).

## The rule
Can't tick a box → not done. Fix it or block explicitly with the owner named; never silently ship past it. Then → launch-gtm-checklist. External publish is always board-gated.
