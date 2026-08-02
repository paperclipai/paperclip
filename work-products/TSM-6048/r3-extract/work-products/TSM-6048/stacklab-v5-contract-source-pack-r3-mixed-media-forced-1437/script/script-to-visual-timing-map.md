# Stack Lab EP1 — Reconciled Script-to-Visual Timing Map (v6 natural narration)
**Script version:** v5 | **Issue:** TSM-6048 reissue | **Date:** 2026-08-01
**Binding runtime:** continuous OpenVoice body 447.738792s + inserts 5.000 + 6.000 + 9.940 = **478.618792s**
**Source of truth for spoken reveals:** forced alignment `alignment.json` (not the stale 15-minute clock).

Treatments and reveal rules are inherited from TSM-5973. Timecodes below are alignment-derived body times (inserts are fixed wall-clock slots).

| Beat # | Body start–end (s) | Visual type | Source | On-screen / reveal |
|---|---|---|---|---|
| 1 | 0.120–49.042 | `stat-card` | `visuals/beat-01.mp4` | 8:42 on screen before forty-two seconds |
| 2 | 49.062–57.442 | `screen-cap` | `visuals/beat-02.mp4` | Run summary |
| 3 | 57.462–60.003 | `motion-graphic` | `visuals/beat-03.mp4` | No new tools |
| 4 | 60.023–62.683 | `b-roll` | `visuals/beat-04.mp4` | Let me show you the timeline |
| 5 | 62.703–72.643 | `screen-cap` | `visuals/beat-05.mp4` | Three stages |
| 6 | 72.663–77.663 | `motion-graphic` | `visuals/beat-06.mp4` | npm + Docker = 7m 26s |
| 7 | 77.683–88.564 | `progressive-list` | `visuals/beat-07.mp4` | Your runner has no memory |
| 8 | 90.564–101.884 | `stat-card` | `visuals/beat-08.mp4` | 80% |
| 9 | 101.904–107.405 | `slide` | `visuals/beat-09.mp4` | Cache by lockfile, not commit |
| 10 | 107.425–128.325 | `code-reveal` | `visuals/beat-10.mp4` | Cache key tied to SHA |
| 11 | 130.406–145.706 | `code-reveal` | `visuals/beat-11.mp4` | hashFiles + restore-keys |
| 12 | 147.086–150.646 | `stat-card` | `visuals/beat-12.mp4` | 2:17 → 4s |
| 13 | 152.666–175.787 | `motion-graphic` | `visuals/beat-13.mp4` | 8:42 → 6:25 |
| 14 | 175.807–184.568 | `slide` | `visuals/beat-14.mp4` | Order Dockerfile stable to volatile |
| 15 | 186.588–209.009 | `code-reveal` | `visuals/beat-15.mp4` | COPY . . too early |
| 16 | 209.029–216.329 | `code-reveal` | `visuals/beat-16.mp4` | Deps first, source second |
| 17 | 216.349–220.849 | `screen-cap` | `visuals/beat-17.mp4` | CACHED 0.0s |
| 18 | 220.909–228.090 | `motion-graphic` | `visuals/beat-18.mp4` | 8:42 → 6:25 → 2:55 |
| 19 | 228.110–228.950 | `slide` | `visuals/beat-19.mp4` | Build once, use everywhere |
| 20 | 228.970–235.030 | `motion-graphic` | `visuals/beat-20.mp4` | Same image ×3 |
| 21 | 235.050–240.070 | `code-reveal` | `visuals/beat-21.mp4` | build → test → deploy |
| 22 | 240.090–246.850 | `motion-graphic` | `visuals/beat-22.mp4` | Build once. Pull twice. |
| 23 | 246.870–252.451 | `stat-card` | `visuals/beat-23.mp4` | 1:12 |
| 24 | n/a (fixed insert) | `[INSERT]` | `visuals/beat-24.mp4` | locked 5.000s |
| 25 | 252.611–258.271 | `slide` | `visuals/beat-25.mp4` | Three quick additions |
| 26 | 258.291–272.992 | `slide` | `visuals/beat-26.mp4` | Parallel stages |
| 27 | 273.012–287.112 | `stat-card` | `visuals/beat-27.mp4` | 800MB → 60MB |
| 28 | 287.132–301.333 | `screen-cap` | `visuals/beat-28.mp4` | Longest step = fix-one target |
| 29 | 301.353–303.453 | `stat-card` | `visuals/beat-29.mp4` | 8:42 |
| 30 | 303.473–309.233 | `progressive-list` | `visuals/beat-30.mp4` | The whole playbook |
| 31 | 309.253–311.833 | `stat-card` | `visuals/beat-31.mp4` | 1:12 · 7× |
| 32 | 311.853–447.079 | `slide` | `visuals/beat-32.mp4` | Where you go from here |
| 33 | n/a (fixed insert) | `[INSERT]` | `visuals/beat-33.mp4` | locked 6.000s |
| 34 | n/a (fixed insert) | `[INSERT]` | `visuals/beat-34.mp4` | locked 9.940s |

## Notes

- Beats 24 / 33 / 34 are locked templates from TSM-5974 (exact SHA-256 in manifest).
- Beat 4 is the only b-roll assignment.
- Progressive-list and code-reveal beats are multi-stage motion encodes (no pre-load stills).
- The production alignment recovered from run 30721295295 is authoritative for every source duration.
- This visual-source package does not alter the locked 15:30–15:45 master-band decision; it only makes every supplied treatment cover the forced-aligned span.

