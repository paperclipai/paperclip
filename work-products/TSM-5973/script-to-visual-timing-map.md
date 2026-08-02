# Stack Lab EP1 — Script-to-Visual Timing Map
**Script version:** v5 | **Issue:** TSM-5973 | **Date:** 2026-08-01  
**Assembly law:** every assembly beat is checked against this map before submission. Visual type and duration are the acceptance criteria — assembly cannot be judged after the fact.

---

## Legend

| Visual type | What it means |
|---|---|
| `stat-card` | Branded slide with a single large number/stat; animates in on-beat |
| `screen-cap` | Real screenshot or rendered screenshot-equivalent of a terminal, IDE, or web UI |
| `code-reveal` | Code block appearing line-by-line or section-by-section, synced to narration |
| `progressive-list` | Bullet list where items animate in one at a time, timed to the VO read |
| `motion-graphic` | Animated data/comparison visual — bar chart, timeline, before/after wipe |
| `b-roll` | Video footage (minimal use per SL per-channel rule; transitions only) |
| `slide` | Branded text/chapter slide; may include short animated text |
| `[INSERT]` | Reusable drop-in clip — does NOT get bespoke production; use the locked asset |

**Rule:** no two consecutive beats may use the same `b-roll` assignment. Screen-caps and code-reveals are the default; b-roll is the exception.

---

## Timing Map

| Beat # | Timecode | Script excerpt (first words) | Visual type | Duration | On-screen content | Sync note |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:07 | "Every push you make…" | `stat-card` | 7s | "8:42" in large type on black/navy | Number appears at "eight minutes" — must be on screen before "forty-two seconds" is spoken |
| 2 | 0:07–0:28 | "That is how long this build takes…" | `screen-cap` | 21s | GitHub Actions run summary: total duration "8m 42s" highlighted | Must match the claimed number exactly — any discrepancy = reject |
| 3 | 0:28–0:52 | "By the end of this, three changes…" | `motion-graphic` | 24s | Before/after bar: "8:42" → "1:12" animates in; label "No new tools" appears | Animation starts at "cut that to"; final stat locked on screen through end of sentence |
| 4 | 0:52–1:05 | "Let me show you where the time goes…" | `b-roll` | 13s | Developer at terminal (generic; brief transition only) | Only b-roll use in the hook; keep short |
| 5 | 1:05–1:40 | "Here is the GitHub Actions timeline…" | `screen-cap` | 35s | GitHub Actions job timeline: three rows annotated — npm install (2:17), docker build (5:09), test run (1:16) | Each duration annotation appears as the number is spoken |
| 6 | 1:40–2:10 | "The npm install and the Docker build together…" | `motion-graphic` | 30s | Timeline highlight: npm + docker bars highlighted, total "7m 26s" appears | Number appears on-screen at "seven and a half minutes" |
| 7 | 2:10–2:32 | "Your CI runner has no memory…" | `progressive-list` | 22s | Three bullets build: "No memory between builds" / "Doesn't know the lockfile hasn't changed" / "Starts from scratch every time" | Each bullet appears as the matching clause is spoken — NOT pre-loaded |
| 8 | 2:32–3:00 | "On a typical feature branch…eighty percent…" | `stat-card` | 28s | "80% of pushes don't change deps" in large type | Stat appears at "eighty percent"; stays on screen through end of section |
| 9 | 3:00–3:28 | "Fix one is the GitHub Actions cache…" | `slide` | 28s | Chapter title slide: "Fix 1 — Cache by lockfile, not commit" with Stack Lab accent | Section break — chapter title only |
| 10 | 3:28–4:15 | "Here is the YAML most teams start with…" | `code-reveal` | 47s | YAML block — bad cache key: `key: ${{ github.sha }}` highlighted in red | SHA line must be visually highlighted; pause at "every commit busts the cache" while SHA stays highlighted |
| 11 | 4:15–5:25 | "Here is the fix — four lines…" | `code-reveal` | 70s | YAML block — fixed cache key: `hashFiles('**/package-lock.json')` revealed line by line | hashFiles line appears exactly as "hashFiles" is spoken; restore-keys section revealed when that clause is narrated |
| 12 | 5:25–5:52 | "npm install drops from two minutes seventeen…" | `stat-card` | 27s | Before/after stat: "npm install: 2:17 → 4s" | Numbers appear on-screen when spoken; both figures must be present simultaneously for 3+ seconds |
| 13 | 5:52–6:18 | "On the timeline: fix one alone…" | `motion-graphic` | 26s | Timeline bar chart: "8:42 → 6:25" animates; "80% of pushes" label | Animation timed so "6:25" locks on at "six twenty-five" |
| 14 | 6:18–6:40 | "Fix two is Dockerfile layer ordering…" | `slide` | 22s | Chapter title slide: "Fix 2 — Order Dockerfile stable to volatile" | Section break |
| 15 | 6:40–7:30 | "Here is the Dockerfile most people write first…" | `code-reveal` | 50s | Dockerfile — before: `COPY . .` then `RUN npm install`; problem line highlighted | "COPY . ." line highlighted in red when "entire project directory" is spoken; cascade annotation appears at "invalidates all twelve layers" |
| 16 | 7:30–8:28 | "The fix is to copy only what npm needs first…" | `code-reveal` | 58s | Dockerfile — after: `COPY package*.json ./` → `RUN npm install` → `COPY . .`; each new line revealed as narrated | Every COPY/RUN line appears at the moment it is described; do NOT show the full fixed Dockerfile before the narration reaches it |
| 17 | 8:28–9:00 | "The build log goes from every step rebuilding…" | `screen-cap` | 32s | Docker build log showing: "Step 4/7: RUN npm install — CACHED 0.0s" | "CACHED" and "0.0s" must be clearly legible at 1080p; zoom if necessary |
| 18 | 9:00–9:28 | "On the timeline: five minutes nine…becomes one twenty…" | `motion-graphic` | 28s | Cumulative bar chart: "8:42 → 6:25 → 2:55" building progressively | Each number animates in when spoken; labels: "Fix 1 + Fix 2, 80% of pushes" |
| 19 | 9:28–9:50 | "Fix three is build once, use everywhere…" | `slide` | 22s | Chapter title slide: "Fix 3 — Build once, use everywhere" | Section break |
| 20 | 9:50–10:20 | "Most multi-job pipelines have a hidden tax…" | `motion-graphic` | 30s | Workflow diagram: 3 parallel jobs each running their own docker build; red "×3" on the repeated build steps | Animation: show the "3× build" anti-pattern first, then wipe to the fix |
| 21 | 10:20–11:15 | "Here is the fix: add a build job…" | `code-reveal` | 55s | GitHub Actions YAML — three jobs: build (push), test (needs: build, pull), deploy (needs: [build, test], pull) | Reveal each job block as it is described; highlight `needs: build` when that line is narrated |
| 22 | 11:15–11:40 | "Build once. Pull twice…" | `motion-graphic` | 25s | Workflow diagram: build → [test, deploy] fan-out; "12s pull" label on test/deploy | "12s" appears when "twelve seconds" is spoken |
| 23 | 11:40–12:00 | "The full pipeline…lands at one minute twelve…" | `stat-card` | 20s | "1:12" in large type on navy; sub-label "build → test → deploy" | Stat appears at "one minute twelve" and holds through end of section |
| 24 | 12:00–12:15 | [MID-VIDEO CTA SLOT] | `[INSERT]` | 15s | Reusable CTA clip — like/subscribe + lead magnet URL | Drop-in locked asset; do NOT re-produce per episode |
| 25 | 12:15–12:32 | "Three quick additions…" | `slide` | 17s | Chapter title: "Going Deeper" | Section break |
| 26 | 12:32–12:55 | "First: BuildKit — on by default since Docker 23…" | `slide` | 23s | Slide: "BuildKit — parallel stages" + simple arrow diagram showing two parallel stage lanes | Diagram animates when "parallel" is spoken |
| 27 | 12:55–13:18 | "Second: multi-stage builds…eight hundred megabytes to sixty…" | `stat-card` | 23s | Before/after stat: "Final image: 800MB → 60MB" | "800MB" appears at "eight hundred megabytes"; "→ 60MB" appears at "sixty" |
| 28 | 13:18–13:48 | "Third: how to find your own bottleneck…" | `screen-cap` | 30s | GitHub Actions step list with duration column; longest step highlighted; arrow annotation "Your fix-one target" | Arrow appears at "the longest step is your fix-one target" |
| 29 | 13:48–14:08 | "Before this: eight minutes, forty-two seconds…" | `stat-card` | 20s | "8:42" full-bleed on navy; no other text | Matches the exact hook stat — visual bookend |
| 30 | 14:08–14:40 | "Three changes: Fix one…Fix two…Fix three…" | `progressive-list` | 32s | Three bullets building one by one: "Cache by lockfile, not commit" / "Dockerfile stable to volatile" / "Build once, use everywhere" | Each bullet appears at the start of that fix's clause — NOT all at once. Hard requirement: zero pre-loading |
| 31 | 14:40–15:00 | "After: one minute, twelve seconds…seven times faster…" | `stat-card` | 20s | "1:12" + "7×" animating in sequence; sub-label "same pipeline, nothing new to maintain" | "7×" appears at "seven times faster" |
| 32 | 15:00–15:22 | "If your build is over ten minutes…under two minutes…" | `slide` | 22s | Two-path slide: "10+ min → these 3 fixes" / "Under 2 min → test parallelism" | Both paths on screen when the corresponding clause is spoken |
| 33 | 15:22–15:37 | [LEAD MAGNET SLOT] | `[INSERT]` | 15s | Reusable lead magnet clip — "CI cache checklist" + URL | Drop-in locked asset; do NOT re-produce per episode |
| 34 | 15:37+ | [OUTRO INSERT] | `[INSERT]` | standard | Locked outro bookend | Reusable asset |

---

## Assembly QA checklist (derived from this map)

Before submitting the v5 assembly for review, verify each item:

- [ ] Beat 1 (stat-card "8:42") is on screen before "forty-two seconds" is spoken — not after
- [ ] Beat 2 (screen-cap) shows the exact number "8m 42s" — any other number = reject
- [ ] Beat 3 (motion-graphic) shows both "8:42" and "1:12" simultaneously for ≥3s
- [ ] Beat 7 (progressive-list) — all 3 bullets arrive separately — zero pre-loading
- [ ] Beat 8 ("80% of pushes") stat appears at "eighty percent", not before or after
- [ ] Beat 10 (code-reveal) — `github.sha` line is highlighted red before the VO reaches it
- [ ] Beat 11 (code-reveal) — `hashFiles` line appears as "hashFiles" is spoken, not before
- [ ] Beat 12 — both "2:17" and "4s" are on-screen together for ≥3s
- [ ] Beat 16 (Dockerfile fix) — each line reveals at its VO mention — no pre-loading
- [ ] Beat 17 — "CACHED 0.0s" legible at 1080p without squinting
- [ ] Beat 18 (cumulative chart) — "6:25" appears at "six twenty-five", "2:55" appears at "two fifty-five"
- [ ] Beat 22 — "12s" appears at "twelve seconds"
- [ ] Beat 24 ([INSERT]) — uses the LOCKED CTA clip, not a bespoke production
- [ ] Beat 27 — "800MB" appears at "eight hundred megabytes", "60MB" appears at "sixty"
- [ ] Beat 29 (recap stat) — matches the exact hook "8:42" — same number, same format
- [ ] Beat 30 — all 3 recap bullets arrive one-at-a-time — zero pre-loading
- [ ] Beat 31 — "1:12" and "7×" appear in that order, timed to the VO
- [ ] Beat 33 ([INSERT]) — uses the LOCKED lead magnet clip, not a bespoke production
- [ ] Beat 34 ([INSERT]) — uses the LOCKED outro bookend
- [ ] No b-roll appears except Beat 4 (hook transition) — any other b-roll use = reject
- [ ] No number spoken in the VO lacks a matching on-screen visual at the moment of speaking
- [ ] Pronunciation dictionary was applied before TTS render (sign off on the checklist in the script)

---

## Visual type coverage summary

| Type | Beat count | % of total |
|---|---|---|
| screen-cap | 5 | 15% |
| code-reveal | 4 | 12% |
| motion-graphic | 6 | 18% |
| stat-card | 7 | 21% |
| progressive-list | 2 | 6% |
| slide | 5 | 15% |
| b-roll | 1 | 3% |
| [INSERT] reusable | 3 | 9% |
| **Total** | **33** | **100%** |

**Abstract b-roll share: 3%** (1 of 33 beats) — complies with the SL per-channel rule (screen-caps default, b-roll exception).
