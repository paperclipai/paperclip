---
name: broll-sourcing
description: How to find and source b-roll, stock video, images, and audio LEGALLY and for free. Use whenever an issue needs stock/b-roll footage, background imagery, or an audio bed — before asking for any generation. Covers Pexels and Pixabay APIs (free keys), Wikimedia Commons and Openverse (CC, attribution required), NASA (public domain), and coverr.co (manual). Hard rules - never scrape YouTube or any ToS-prohibited platform; record source URL plus licence per asset in the issue; download via API into the workspace assets/ dir with a manifest.json.
---

# B-roll Sourcing

Free, legal stock first; generation (video-gen-ops / image-gen-ops) only for what
stock cannot supply. Every asset that enters the workspace gets a licence record —
an asset without provenance is a liability, not a deliverable.

## HARD RULES (non-negotiable)

1. **Never scrape or download from YouTube** — no yt-dlp, no screen capture of other
   people's videos, no "it's just b-roll". The same applies to any platform whose
   ToS prohibits downloading (TikTok, Instagram, Vimeo standard licence, etc.).
   "Creative Commons on YouTube" still goes through the rights holder, not a ripper.
2. **Record source URL + licence per asset in the issue** — a table or list:
   file, source page URL, licence name, author (if attribution required), and
   whether attribution text must ship with the published video.
3. **Prefer API download into the workspace** — assets land in `assets/broll/`
   (or `assets/audio/` for beds) with a `manifest.json` next to them (format below).
   The reference script does this: `references/fetch-broll.sh`.
4. **Attribution obligations travel with the asset.** CC BY / BY-SA assets need the
   attribution line in the published description; record the exact line in the
   manifest. If the publish surface can't carry attribution, don't use the asset.
5. **No NC/ND for commercial work.** Portfolio output is commercial: filter out
   CC NonCommercial and NoDerivs licences at search time (Openverse/Commons).

## Sources, in preference order

| Source | Key | Licence | Attribution |
|---|---|---|---|
| Pexels (photo+video) | `PEXELS_API_KEY` (free, pexels.com/api) | Pexels licence: free commercial use; no selling unmodified copies; don't imply endorsement by identifiable people/brands | Not required (record source anyway) |
| Pixabay (photo+video+music) | `PIXABAY_API_KEY` (free, pixabay.com/api/docs) | Pixabay Content Licence: free commercial use; no standalone redistribution/sale | Not required (record source anyway) |
| Openverse (CC index, photo+audio) | none | Varies PER ASSET — filter `license_type=commercial,modification` | Per asset; usually required |
| Wikimedia Commons | none (set a descriptive User-Agent) | Varies PER FILE — read `extmetadata` | Usually required (CC BY/BY-SA); record exact line |
| NASA image/video library (images-api.nasa.gov) | none | US public domain (verify per item — some contain third-party material) | Courtesy credit "NASA" |
| coverr.co (video) | manual download | Coverr licence: free commercial use | Not required |

Rate limits are generous but real: Pexels ~200 req/hr & 20k/month; Pixabay ~100 req/min
(and asks you to cache results, not hotlink); Openverse anonymous access is rate-limited
— register for higher limits if you hit 429s. Exact REST patterns, query parameters,
and licence-filter flags: **references/api-reference.md**.

## Workflow

1. **Spec the need** from the shot list (video-gen-ops): subject, motion, duration
   needed, orientation (landscape/portrait), minimum resolution.
2. **Search & fetch** with `references/fetch-broll.sh` (Pexels + Openverse; prints
   key-setup instructions when keys are absent) or the patterns in
   references/api-reference.md for the other sources:
   ```bash
   bash ~/paperclip/skills/broll-sourcing/references/fetch-broll.sh \
     "city skyline timelapse" --type video --count 3 --out assets/broll
   ```
3. **Manifest** — the script appends to `assets/broll/manifest.json`; for manual
   downloads (coverr, NASA) add the entry yourself:
   ```json
   {
     "file": "pexels-857195.mp4",
     "source_url": "https://www.pexels.com/video/857195/",
     "source": "pexels",
     "licence": "Pexels License",
     "author": "<creator name>",
     "attribution_required": false,
     "attribution_text": "",
     "query": "city skyline timelapse",
     "fetched_at": "2026-06-11T12:00:00Z"
   }
   ```
4. **Report on the issue**: the per-asset licence table (rule 2), plus anything you
   could NOT source legally — that residue is the input to video-gen-ops generation.

## Quality bar

- Match or exceed the deliverable spec resolution. Prefer native resolution. Existing
  720p b-roll may be Mini-upscaled only when it is short, non-text, non-hero background
  footage and the manifest records its original dimensions/hash, target dimensions/hash,
  intended use, and passing visual QA. Never upscale UI/capture proof, charts, readable
  text, evidence, or hero footage.
- Reject clips with visible logos, identifiable private individuals in sensitive
  contexts, or watermarks — even when the licence technically allows them.
- Music/audio beds: Pixabay music or other explicit-licence sources only; "found it
  on a beats site" is not a licence.


<!-- TOOLS-2026-06 -->
## Local tools
- `yt-dlp` is permitted **only** to pull a single clip/frame to *study* (write a
  generation prompt, match a look) — **never into a deliverable**. Ripped footage
  does not enter `assets/` or a published video. This does not loosen HARD RULE 1;
  when the two seem to conflict, HARD RULE 1 wins.
