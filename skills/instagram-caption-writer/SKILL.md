---
name: instagram-caption-writer
description: Draft Instagram captions for Bobby Tours sites that queue into Buffer for scheduled posting. Each caption is on-brand per site, uses correct hashtag strategy, respects IG caption length (125-2200 chars), and includes the WhatsApp CTA. Use for weekly social routine.
---

# Instagram Caption Writer

## When to use

- Weekly social content drop per site (Thursday 10:00 EAT routine)
- On-demand when an itinerary / blog post launches (promote on IG)
- For evergreen reshare slots (same asset, new caption angle)

## Per-site Instagram accounts + Buffer channels

| Site | Buffer channel | IG handle (tentative) |
|---|---|---|
| bobby-safaris | BUFFER_CHANNEL_BOBBY | @bobbysafaris |
| safaris-tanzania | BUFFER_CHANNEL_SAFARIS | @safaris_tanzania |
| magical-tanzania | BUFFER_CHANNEL_MAGICAL | @magical_tanzania |
| safari-kilimanjaro | BUFFER_CHANNEL_KILI (maybe?) | @safarikilimanjaro |
| mount-kilimanjaro-climb | BUFFER_CHANNEL_KILI (maybe?) | @mountkilimanjaro_climb |

**Note**: Env has 4 Buffer channels (BOBBY, SAFARIS, MAGICAL, KILI). 5 sites, 4 channels. One of the "kili" sites (safari-kilimanjaro vs mount-kilimanjaro-climb) shares or has no IG. **Check with user** before posting — if unsure which BUFFER_CHANNEL_KILI maps to, default to mount-kilimanjaro-climb (the pure-climb brand), and flag safari-kilimanjaro as "social: unconfigured".

## Caption rules

### Hard rules
1. **Length**: 125–1500 chars. Under 125 = looks thin; over 1500 = truncated in feed.
2. **First line < 125 chars** — it's what shows before "...more". Hook must land here.
3. **WhatsApp CTA** at end: `WhatsApp us: wa.me/255786110786` or `Link in bio`.
4. **Hashtags** (site-specific set): 5–10 hashtags, block at end or in first comment.
5. **Mentions**: only @ the 5 Bobby Tours accounts, never competitors (P9).
6. **No emoji overload**: 2–5 emojis max, placed meaningfully.
7. **Location tag**: always add (Serengeti, Ngorongoro, Kilimanjaro, etc.) when applicable.
8. **No misleading**: if image shows lions, don't caption leopards.

### Soft rules
- Mix content types across the month: 40% wildlife/landscape, 20% lodge/camp, 20% guide/team/human, 10% itinerary spec, 10% testimonial / UGC.
- Tuesday/Thursday/Saturday are peak engagement days. Pick 1 day/week per site for the scheduled post.
- Always include 1 "proof" element: a review quote, booking count, specific number.

## Per-site caption templates + hashtag packs

### bobby-safaris (@bobbysafaris) — ultra-luxury
Voice: heritage, family, quiet-confidence. Reference `site-voice-bobby-safaris`.

Hashtags: `#BobbySafaris #TanzaniaSafari #LuxurySafari #PrivateSafari #Since1978 #SerengetiSafari #NgorongoroCrater #GrumetiReserve #AfricanTravel #LuxuryTravel`

Example:
```
Four generations of Kassim family have led guests into the Serengeti. 1978, my grandfather drove the first Land Cruiser. Today our fleet has twelve. Same workshop, same attention.

Private guide, your own vehicle, zero brokers between you and the bush.

WhatsApp us: wa.me/255786110786

#BobbySafaris #TanzaniaSafari #Since1978 #LuxurySafari #SerengetiSafari #PrivateSafari
```

### safaris-tanzania (@safaris_tanzania) — direct operator
Voice: warm-confident, no-broker. Reference `site-voice-safaris-tanzania`.

Hashtags: `#SafarisTanzania #TanzaniaSafari #DirectOperator #SerengetiSafari #TanzaniaGuide #TarangireNationalPark #NgorongoroConservation #AfricanWildlife #TanzaniaTravel`

### magical-tanzania (@magical_tanzania) — editorial
Voice: magazine-style, opinionated, transparent. Reference `site-voice-magical-tanzania`.

Hashtags: `#MagicalTanzania #TanzaniaSafari #SafariCamps #LuxuryTravel #SafariGuide #TanzaniaTravel #NgorongoroCrater #SerengetiNationalPark`

### safari-kilimanjaro (@safarikilimanjaro) — adventure combo
Voice: energetic, WhatsApp-first. Reference `site-voice-safari-kilimanjaro`.

Hashtags: `#SafariKilimanjaro #KilimanjaroClimb #TanzaniaSafari #KiliCombo #MountKilimanjaro #SummitSuccess #AdventureTravel`

### mount-kilimanjaro-climb (@mountkilimanjaro_climb) — bold athletic
Voice: data-confident, route-specific, safety-first. Reference `site-voice-mount-kilimanjaro-climb`.

Hashtags: `#MountKilimanjaroClimb #KilimanjaroClimb #KiliRoutes #LemoshoRoute #MachameRoute #SummitKili #MountaineeringTanzania #UhuruPeak`

## Procedure

1. **Pick content asset** for this week's post. Options:
   - An image from `/srv/newpaperclip/bobby-tours/<repo>/public/images/` (check image copyright — must be Bobby Tours owned)
   - Stock asset from content brief outputs
   - Recent testimonial/review quote
   - Recent itinerary page

2. **Draft caption** using the per-site voice skill + this skill's rules.

3. **Validate**:
   - [ ] Length 125–1500 chars
   - [ ] First line < 125 chars
   - [ ] WhatsApp CTA present with correct number (+255786110786)
   - [ ] 5–10 hashtags from the site's hashtag pack
   - [ ] Voice rules per site-voice-<slug>
   - [ ] No competitor names (P9 forbidden list)
   - [ ] No misleading claims vs image

4. **Queue to Buffer** — use `buffer-queue-draft` skill to push into Buffer's draft queue.

5. **Report**:
   ```
   ## Instagram caption — <site> for <scheduled-date>
   
   **Asset**: /srv/newpaperclip/bobby-tours/<repo>/public/images/<file>.jpg
   **Caption** (134 chars first line, 892 total):
   [caption text]
   
   **Hashtags**: [hashtag block]
   **Schedule**: Thursday 10am EAT (Buffer will post)
   **Buffer queue ID**: <after-queue>
   ```

## Pitfalls

- IG truncates at ~125 chars before "...more" in feed. Front-load the hook.
- Emoji rendering differs on Android vs iOS — prefer common emojis (🦁 🏔 🌍) over obscure.
- Hashtags in caption body reduce organic reach post-2023. Prefer first-comment placement, or bottom of caption with 2 blank lines of separation.
- Buffer API sometimes silently fails on `#` in plain text — escape carefully or use their structured "tags" field.
- IG Reels captions are shorter (750 chars) and prioritize first 100 chars. Rules slightly different.

## Related skills

- `site-voice-<slug>` — voice anchor
- `buffer-queue-draft` — pushes caption into Buffer
- `lead-handoff-protocol` — WhatsApp number + CTA standard
- `meta-description-writer` — hook-writing discipline transfers

## Budget

$0.05–0.15 per caption.
