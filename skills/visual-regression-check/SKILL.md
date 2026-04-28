---
name: visual-regression-check
description: Take screenshots of key pages on a Bobby Tours site and diff them against yesterday's baseline. Use daily or after every staging→main promotion. Detects layout breaks, brand-color drift, missing images, and unintended visual changes. Runs on the Paperclip VPS (not Contabo — no build here, just fetches live URL).
---

# Visual Regression Check

## When to use

- **Daily 04:00 EAT** — after staging→main promotion at 02:00 EAT + Contabo deploy by 02:15–02:30
- **After every staging→main promotion** — event-driven (ideal, but daily cadence is fine MVP)
- **Before approving PRs** with substantial UI changes — reviewer runs manually

## Important constraint

**You are running on the Paperclip VPS (16 GB, 4 vCPU)**, not Contabo. **Do NOT run `next build` here.** Your job is to:
1. Fetch the LIVE site via HTTPS (the deployed Cloudways-hosted version)
2. Screenshot with playwright in headless mode (lightweight)
3. Diff against yesterday's baseline stored at `/srv/newpaperclip/visual-baselines/<site>/<page>/<breakpoint>.png`

## Pages per site (MVP — homepage + contact)

Start with 2 pages per site. Expand later as needed:

| Site | Homepage | Secondary |
|---|---|---|
| bobby-safaris | https://bobbysafaris.com/ | https://bobbysafaris.com/contact |
| safaris-tanzania | https://safaris-tanzania.com/ | https://safaris-tanzania.com/contact |
| magical-tanzania | https://magicaltanzania.com/ | https://magicaltanzania.com/contact |
| safari-kilimanjaro | https://safarikilimanjaro.com/ | https://safarikilimanjaro.com/contact |
| mount-kilimanjaro-climb | https://mountkilimanjaroclimb.com/ | https://mountkilimanjaroclimb.com/contact |

## Breakpoints

- **mobile**: 390×844 (iPhone 13 Pro dimensions)
- **desktop**: 1440×900 (common laptop)

So per site: 2 pages × 2 breakpoints = 4 screenshots.

## Procedure

1. **Ensure baseline dir exists:**
   ```bash
   SITE=<your-site-slug>   # e.g. bobby-safaris
   BASELINE_DIR=/srv/newpaperclip/visual-baselines/$SITE
   TODAY_DIR=/srv/newpaperclip/visual-snapshots/$SITE/$(date +%Y-%m-%d)
   mkdir -p "$TODAY_DIR"
   ```

2. **For each page × breakpoint, take a screenshot with playwright (Node or Python):**

   Using the pre-installed `playwright` (location: `/usr/bin/playwright`):

   ```bash
   cat > /tmp/screenshot.js <<EOJS
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.launch({ headless: true });
     const ctx = await browser.newContext({
       viewport: { width: ${WIDTH}, height: ${HEIGHT} },
       deviceScaleFactor: 1,
     });
     const page = await ctx.newPage();
     await page.goto('${URL}', { waitUntil: 'networkidle', timeout: 30000 });
     await page.waitForTimeout(2000); // let lazy images load
     await page.screenshot({ path: '${OUTPUT}', fullPage: true });
     await browser.close();
   })();
   EOJS
   node /tmp/screenshot.js
   ```

3. **Diff against baseline** using `pixelmatch` (via `npx`):

   ```bash
   npx --yes pixelmatch \
     "$BASELINE_DIR/$PAGE-$BREAKPOINT.png" \
     "$TODAY_DIR/$PAGE-$BREAKPOINT.png" \
     "/tmp/diff-$PAGE-$BREAKPOINT.png" \
     --threshold 0.1 2>&1 | tail -5
   # Output format: "N different pixels"
   # Also compute % diff: N / (WIDTH × HEIGHT)
   ```

4. **Thresholds:**
   - **<0.5% diff**: PASS (noise, fonts loading differently, etc.)
   - **0.5–5% diff**: WARN (investigate but don't block)
   - **>5% diff**: FAIL — Telegram alert, block any pending staging→main promotion

5. **First-run / missing-baseline:**
   If `$BASELINE_DIR/$PAGE-$BREAKPOINT.png` doesn't exist, this is first run:
   - Copy today's snapshot to baseline: `cp "$TODAY_DIR/$PAGE-$BREAKPOINT.png" "$BASELINE_DIR/$PAGE-$BREAKPOINT.png"`
   - Report "baseline established" for this page/breakpoint

6. **Baseline rotation** — after successful PASS (or accepted WARN), replace baseline with today's snapshot:
   ```bash
   # Only if user hasn't flagged a regression
   cp "$TODAY_DIR/$PAGE-$BREAKPOINT.png" "$BASELINE_DIR/$PAGE-$BREAKPOINT.png"
   ```
   This way baseline drifts with site over time, catches abrupt changes.

7. **Snapshot retention:**
   - Today's snapshots: keep 30 days, then delete oldest
   - Baselines: keep indefinitely

8. **Report format:**

   ```
   ## Visual regression — <site> (2026-04-20)
   
   | Page | Breakpoint | Diff % | Status | Baseline updated |
   |---|---|---|---|---|
   | / | mobile | 0.2% | ✅ | yes |
   | / | desktop | 0.1% | ✅ | yes |
   | /contact | mobile | 7.2% | ❌ FAIL — Telegram alerted | no |
   | /contact | desktop | 0.3% | ✅ | yes |
   
   ### Action items
   - [ ] Investigate /contact mobile — diff image at /srv/newpaperclip/visual-snapshots/<site>/2026-04-20/contact-mobile-diff.png
   - [ ] Possibly roll back today's staging→main promotion if change unintended
   
   ### Telegram alert sent
   ⚠ Visual regression on <site>/contact (mobile) — 7.2% diff, investigate
   ```

## Pitfalls

- **Animation frames** — Framer Motion on safaris-tanzania can produce different first-paint per run. Use `waitForTimeout(2000)` to let animations settle.
- **Dynamic content** — date pickers, carousel randomization, review rotators cause false positives. Option: identify dynamic zones via CSS selectors and mask them (`page.screenshot({ mask: [...] })`).
- **Font loading flicker** — load all fonts before screenshot: `await page.waitForFunction(() => document.fonts.ready)`.
- **CDN image lazy-load** — if images below fold haven't loaded, diff will show them as missing. Either scroll page first or use `fullPage: true` (we do).
- **Network flakiness** — use `networkidle` wait state + retry on timeout.

## Baseline initialization (first deploy of this skill)

On first run per site, there's no baseline — the skill creates one. So first run ALWAYS passes. Real validation starts on run 2.

To establish baselines proactively (recommended):
```bash
# Run this once per site
/tmp/screenshot.js for each page × breakpoint
cp all outputs to /srv/newpaperclip/visual-baselines/<site>/
```

## Related skills

- `next-image-optimization` — broken images cause big diffs
- `accessibility-audit` — layout issues often surface in both
- `core-web-vitals-audit` — CLS regressions often show as diff

## Budget

$0.10–0.30 per site per run. Playwright is lightweight headless chromium (~200 MB RAM per instance); 5 sites sequentially is fine on the Paperclip VPS.
