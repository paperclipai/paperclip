---
name: core-web-vitals-audit
description: Audit and gate Core Web Vitals (LCP, CLS, INP) for Bobby Tours Next.js sites. Use when reviewing PRs, investigating SEO ranking drops, or validating deploys. Thresholds: LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms.
---

# Core Web Vitals Audit

## When to use

- Before approving any PR that touches components, fonts, images, or scripts in `/srv/newpaperclip/bobby-tours/<repo>`
- After a deploy to verify no regressions vs last known baseline
- When SEO reports ranking drops or impression decline in GSC
- As part of the weekly SEO routine

## Thresholds (hard gate)

| Metric | Good | Poor | Source of truth |
|---|---|---|---|
| LCP | ≤ 2.5 s | > 4.0 s | PageSpeed API / CrUX |
| CLS | ≤ 0.1 | > 0.25 | PageSpeed API / CrUX |
| INP | ≤ 200 ms | > 500 ms | PageSpeed API / CrUX |
| TTFB | ≤ 600 ms | > 1.5 s | server log / CrUX |

## Procedure

1. **Identify target URL** — if auditing a PR, pick the most-trafficked route touched (typically homepage `/` or an itinerary/route page).

2. **Run PageSpeed Insights API** (no key needed for low-volume):
   ```
   curl -s "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://<domain>/<path>&category=PERFORMANCE&strategy=MOBILE" | jq '.lighthouseResult.audits | {lcp: ."largest-contentful-paint".numericValue, cls: ."cumulative-layout-shift".numericValue, inp: ."interaction-to-next-paint".numericValue, tti: ."interactive".numericValue}'
   ```
   Run BOTH `strategy=MOBILE` and `strategy=DESKTOP`.

3. **For localhost/staging audits** — run Lighthouse CI in headless mode:
   ```
   npx lighthouse http://localhost:3000/<path> --only-categories=performance --output=json --quiet --chrome-flags="--headless --no-sandbox" | jq '.audits | {lcp, cls, inp: ."interaction-to-next-paint"}'
   ```

4. **Compare to main branch baseline** — the build artifact at `.next/analyze/` (if configured) or prior PR's Lighthouse run. A >10% regression on any metric is a fail.

5. **Common culprits + fixes** (report these when a metric fails):
   - LCP > 2.5s → Hero image not WebP/AVIF, missing `priority` prop, render-blocking font load. Fix: convert image format, add `priority` on LCP image, `next/font` with `display: swap`.
   - CLS > 0.1 → Image without explicit `width`/`height` causing layout shift, lazy-loaded fonts swapping. Fix: explicit dimensions on all images, `font-display: optional` or preload critical fonts.
   - INP > 200ms → Heavy JS on main thread (especially Framer Motion cascades, Google Tag Manager early), hydration blocking. Fix: dynamic import non-critical components, defer analytics, move Framer Motion variants outside render.
   - TTFB > 600ms → Slow server response, SSR heavy. Fix: check Contabo build artifacts, enable ISR with `revalidate`.

6. **Report format** (post as ticket comment):

   ```
   ## Core Web Vitals — <URL>
   | Metric | Mobile | Desktop | Threshold | Status |
   |---|---|---|---|---|
   | LCP | 2.1s | 1.4s | ≤2.5s | ✅ |
   | CLS | 0.02 | 0.01 | ≤0.1 | ✅ |
   | INP | 180ms | 120ms | ≤200ms | ✅ |
   | TTFB | 520ms | 310ms | ≤600ms | ✅ |
   
   Baseline delta: LCP -0.1s, CLS +0.01 (within tolerance).
   Verdict: PASS / FAIL
   ```

## Pitfalls

- PageSpeed API is rate-limited without a key. For audits on all 5 sites at once, add key or space out requests.
- Mobile scores are the hard gate — desktop is usually 2-3× better and not representative.
- Cold-cache runs inflate LCP. Run twice and take the second number for consistency.
- `npx next build` WITHOUT `--profile` gives you a bundle-size report but NOT CWV. You need a deployed URL or `next start` + Lighthouse.

## Related skills

- `next-image-optimization` — fix LCP from image issues
- `next-build-gate` — verify the build compiles before running CWV on it
- `gsc-audit` — cross-reference CWV regressions with GSC "Page Experience" report

## Budget

Allow $0.20–$0.50 per audit run (Lighthouse + PageSpeed curl is cheap; cost is in reading + interpreting output).
