---
name: accessibility-audit
description: Audit a Bobby Tours page or site for WCAG 2.1 AA compliance — alt text, keyboard nav, color contrast, ARIA, form labels. Use during PR review, pre-launch, or when Axe/Lighthouse flags accessibility issues.
---

# Accessibility Audit (WCAG 2.1 AA)

## When to use

- Every PR review (reviewer role) — lightweight check
- Before shipping a new page type (itinerary, booking form, FAQ, hero) — full audit
- When lighthouse's accessibility score drops below 95
- Annual compliance sweep

## Checklist (AA level — what Bobby Tours targets)

### Perceivable
- [ ] Every `<img>` / `<Image>` has `alt` (empty string `alt=""` is OK for decorative only)
- [ ] No color-only meaning (icons + text labels, not just red/green dots)
- [ ] Text contrast: 4.5:1 for body text, 3:1 for large text (≥18pt or bold ≥14pt), 3:1 for UI components
- [ ] Resizable to 200% without horizontal scroll (mobile Safari default)
- [ ] Captions / transcripts for any video (rare on these sites)

### Operable
- [ ] All interactive elements keyboard-accessible (Tab, Enter, Space, Esc as appropriate)
- [ ] Visible focus ring on ALL focusable elements (`outline: 2px solid <color>` or ring utility)
- [ ] Skip-to-content link (hidden but focusable) at top of page
- [ ] No keyboard traps (especially in modals / carousels)
- [ ] Touch targets ≥ 44×44 px on mobile
- [ ] No auto-playing audio/video with sound

### Understandable
- [ ] `<html lang="...">` set per locale (`de`, `en`, `es`, `fr`, `it`, `ja`, `ko`, `nl`, `pt`, `zh`, etc.)
- [ ] Form inputs have associated `<label>` or `aria-label`
- [ ] Error messages identify the field + describe fix
- [ ] Consistent nav across pages
- [ ] Links use descriptive text (NOT "click here")

### Robust
- [ ] Valid HTML (no unclosed tags, duplicate IDs)
- [ ] ARIA roles used only when semantic HTML insufficient
- [ ] No `role="button"` on `<div>` when `<button>` will do
- [ ] No `aria-hidden="true"` on focusable elements

## Procedure

1. **Run axe-core via Lighthouse on the target page:**
   ```bash
   npx lighthouse http://localhost:3000/<path> --only-categories=accessibility --output=json --quiet --chrome-flags="--headless --no-sandbox" | jq '.audits | to_entries[] | select(.value.score==0) | {id: .key, title: .value.title, description: .value.description}'
   ```
   Any entry returned is a WCAG AA failure.

2. **Quick keyboard test** (manually describe in ticket):
   - Tab through the page from top. Does focus follow visual order?
   - Can you reach every interactive element with Tab/Shift+Tab?
   - Can you submit forms, open/close modals, operate carousel without a mouse?
   - Is the focus ring always visible?

3. **Color contrast spot checks** — for the top 3 text colors on body, links, and CTAs:
   ```bash
   # hex contrast ratio check
   python3 -c "
   def contrast(fg, bg):
       def lum(c):
           r,g,b = int(c[0:2],16)/255, int(c[2:4],16)/255, int(c[4:6],16)/255
           def v(x): return x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4
           return 0.2126*v(r)+0.7152*v(g)+0.0722*v(b)
       l1, l2 = sorted([lum(fg), lum(bg)], reverse=True)
       return (l1+0.05)/(l2+0.05)
   print(contrast('333333', 'FFFFFF'))  # body on white
   "
   ```

4. **Form audit** (for booking / inquiry forms):
   - Each input has `<label>` OR `aria-label`
   - Required fields marked both visually (*) and with `aria-required="true"` or `required`
   - Error state uses `aria-invalid="true"` and error text linked via `aria-describedby`
   - Submit button clearly labeled (not "Submit" — use action verb: "Send inquiry", "Request quote")

5. **Image + icon audit:**
   ```bash
   # find all Image/img without alt
   grep -rn '<Image' src/app/ | grep -v 'alt='  # should return nothing
   ```

6. **Report format:**

   ```
   ## a11y audit — <URL>
   Lighthouse a11y score: 94 (target: ≥95)
   
   ### Fails (must fix)
   1. Color contrast 3.8:1 on footer links (target 4.5:1) — `/components/Footer.tsx:42`
      Fix: change #888 → #555 (6.4:1)
   2. Button "→" has no accessible name — `/components/HeroCTA.tsx:18`
      Fix: add `aria-label="Learn more"` or visible text
   
   ### Warnings (recommend fix)
   - Focus ring not visible on primary CTA (uses `outline: none` with no replacement)
   
   ### Passes
   - All 47 images have alt text ✓
   - Lang attribute set correctly ✓
   - Form labels associated ✓
   
   Verdict: 2 fails — block merge until resolved
   ```

## Site-specific notes

- **bobbysafaris.com** — 4,067 TripAdvisor "5★" reviews rendered as icons. Ensure star icons have `aria-label="5 out of 5 stars"` each (or the container does).
- **safari-kilimanjaro.com** — SuccessRateCalculator is interactive; MUST be keyboard-operable and screen-reader friendly.
- **mountkilimanjaroclimb.com** — success-rate cards with percentages: ensure percentages aren't only visual (e.g. just a ring).
- **magicaltanzania.com** — editorial full-bleed images need caption component for decorative context.
- **safaris-tanzania.com** — Framer Motion animations must respect `prefers-reduced-motion`.

## Pitfalls

- Lighthouse a11y score = 100 doesn't guarantee WCAG AA. Manual testing is required.
- `aria-label` on a visible-text element is usually redundant. Don't add both.
- Over-ARIA'd pages break screen readers worse than under-ARIA'd. `<button>` > `<div role="button" tabindex="0" onKeyDown={...}>`.
- Color-blind users: trust the contrast ratio math, don't eyeball.

## Related skills

- `core-web-vitals-audit` — CLS <0.1 helps readability
- `site-voice-<slug>` — accessible language is clearer language; voice rules usually align

## Budget

$0.20–0.50 per page audit (Lighthouse is free; cost is in reading output + writing report).
