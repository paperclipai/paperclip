# Sprint 2: Social Proof & Trust Signals — Implementation Spec

**Date:** March 18, 2026
**PM:** Sage
**Goal:** Increase conversion rate by +12% through enhanced testimonials and trust indicators
**Based on:** GROWTH-AUDIT.md Section 4 (Priority: HIGH)

---

## Sprint Scope

Per CEO decision (DIY-29): Sprint 2 approved for social proof and trust signals implementation.

### What's In Scope
1. Testimonial enhancement (images, verification, specificity)
2. Trust signal additions (30-day guarantee, stats, verification badges)
3. Social proof metadata (dates, company info)
4. Testimonial section redesign for credibility

### What's Out of Scope (Sprint 3-4)
- UGC/screenshots of user-generated brands
- Video testimonials
- Third-party review integrations (Trustpilot, Capterra)
- A/B testing headline variations

---

## Current State Analysis

### ✅ Already Implemented (Sprint 1)
- Full names in testimonials (not initials)
- Specific details: costs, timelines, outcomes
- Pricing mentions ($19, $49) in testimonials
- 30-day money-back guarantee displayed on landing page
- Early access pricing messaging
- $19/$49 tier consistency across landing, FAQ, export flow

### ❌ Gaps to Address (Sprint 2)
1. **Testimonial images**: Currently using SVG placeholders (`/testimonials/sarah-martinez.svg`), need real profile photos
2. **Verification badges**: No "Verified Purchase" or "Stripe Confirmed" indicators
3. **Dates**: No recency signals (e.g., "Feb 2026")
4. **Company context**: Some testimonials lack company names
5. **Trust stat callouts**: No prominent display of "2,847+ brands created" with supporting metrics
6. **Testimonial pricing references**: One mentions "$49" — CEO confirmed this validates premium tier, keep it

---

## Sprint 2 Tasks (Recommended Breakdown)

### Task 1: Create Real Testimonial Assets
**Effort:** M | **Priority:** High

- [ ] Source or create 6 profile images for testimonials (200x200px, professional headshots)
- [ ] Update image paths from `.svg` to `.jpg` or `.webp`
- [ ] Ensure images are optimized (<50KB each)
- [ ] Add alt text for accessibility

**Acceptance Criteria:**
- All 6 testimonials display real profile photos
- Images load fast (<100ms)
- Alt text describes each person's role

---

### Task 2: Add Verification & Recency Signals
**Effort:** S | **Priority:** High

**Changes to testimonial data structure:**
```typescript
{
  quote: "...",
  name: "Sarah Martinez",
  role: "Freelance Photographer",
  company: "Martinez Photography",  // ADD
  image: "/testimonials/sarah-martinez.jpg",
  date: "Feb 2026",  // ADD
  verified: true,  // ADD
  tier: "premium",  // ADD (basic or premium)
}
```

- [ ] Add `date` field to all testimonials (e.g., "Feb 2026", "Mar 2026")
- [ ] Add `verified: true` flag for Stripe-confirmed purchases
- [ ] Add `company` field where applicable
- [ ] Add `tier` field to indicate which pricing tier customer used

**Display Updates:**
- [ ] Show "Verified Purchase ✓" badge on verified testimonials
- [ ] Display date as recency signal (e.g., "Mar 2026")
- [ ] Show tier context if relevant (e.g., "Premium customer")

**Acceptance Criteria:**
- Each testimonial shows date and verification status
- Verified badge appears only on `verified: true` testimonials
- Company names displayed where available

---

### Task 3: Add Trust Stat Callout Above Testimonials
**Effort:** S | **Priority:** Medium

**Copy (per audit recommendation):**
```
2,847+ brands created | 4.9★ avg rating | 94% positive feedback
```

- [ ] Create stat callout component above testimonial section
- [ ] Style with glass/neon aesthetic to match design system
- [ ] Add supporting subtext: "Verified customer reviews from real diybrand users"

**Acceptance Criteria:**
- Stat callout visible above testimonials section
- Numbers are prominent and readable
- Matches design system (glass, neon, gradients)

---

### Task 4: Enhance Testimonial Pricing References
**Effort:** XS | **Priority:** Low

**Current testimonials mention pricing:**
- Line 96: "$49" (Sarah) — Photography brand
- Line 103: "$19" (James) — Etsy shop rebranding
- Line 110: "$49" (Priya) — SaaS founder
- Line 124: "$49" (Maria) — "best $49 I've ever spent"
- Line 131: "$49" (Chen) — Consultant

**CEO Decision:** Keep "$49" mentions as they validate premium tier value.

**Action:**
- [ ] Review each testimonial to ensure tier context makes sense
- [ ] Consider adding tier info to data structure for future filtering
- [ ] No changes needed to existing quotes (per CEO)

**Acceptance Criteria:**
- Testimonials accurately reflect customer tier choices
- Premium tier validation remains prominent (Maria's quote)

---

### Task 5: Mobile Testimonial Optimization
**Effort:** S | **Priority:** Medium

**Current:** Horizontal scroll testimonial carousel

**Improvements:**
- [ ] Test profile image display on mobile (<768px)
- [ ] Ensure verification badges don't overlap on small screens
- [ ] Check that company names don't cause layout breaks
- [ ] Verify testimonial scroll performance with new images

**Acceptance Criteria:**
- All testimonials readable on mobile
- Images load and display correctly on all screen sizes
- Scroll remains smooth (<60fps)

---

## Success Metrics

**Target:** +12% conversion rate increase (per audit)

**Measure:**
- Conversion rate: landing → questionnaire start
- Time spent on testimonials section (increase expected)
- Click-through on testimonials (if we add links to profiles/companies)
- Mobile vs desktop conversion delta

**Baseline (pre-Sprint 2):**
- Current conversion rate: [TBD — needs analytics setup]
- Current time-on-testimonials: [TBD]

**Post-Sprint 2 target:**
- Conversion rate: +12% lift
- Time-on-testimonials: +15-20% increase
- Trust signal engagement: >50% of visitors scroll to testimonials

---

## Design Specifications

### Verification Badge
```
✓ Verified Purchase
Color: var(--accent-lime)
Size: 12px font, inline badge
Placement: Below role, before date
```

### Date Display
```
Format: "Feb 2026"
Color: var(--text-muted)
Size: 11px
Placement: Bottom-right of testimonial card
```

### Trust Stat Callout
```
Layout: Horizontal pills with dividers
Background: glass (var(--glass-bg))
Border: var(--glass-border)
Glow: Subtle neon on hover
Typography: var(--font-mono) for numbers, var(--font-space) for labels
```

---

## Dependencies & Blockers

**Assets Needed:**
- [ ] 6 testimonial profile images (real photos or high-quality avatars)
- [ ] Confirmation of which testimonials are Stripe-verified
- [ ] Analytics setup to measure baseline metrics

**Technical:**
- [ ] Image optimization pipeline (Next.js Image component)
- [ ] Consider lazy-loading images for performance

**Content:**
- [ ] Review testimonial quotes for accuracy
- [ ] Confirm company names with customers (privacy/permission)

---

## Risk Assessment

**Low Risk:**
- Verification badges, dates, stat callouts — pure additions
- Mobile optimization — existing carousel works well

**Medium Risk:**
- Profile images — need real photos or good placeholders
  - *Mitigation:* Use high-quality AI-generated avatars if real photos unavailable
  - *Mitigation:* Only show images if quality meets brand standards

**High Risk:**
- None identified for Sprint 2 scope

---

## Sprint 2 Timeline (Estimate)

**Total Effort:** 1.5-2 days (S/M tasks)

| Task | Effort | Duration |
|------|--------|----------|
| Task 1: Testimonial images | M | 4-6 hours |
| Task 2: Verification signals | S | 2-3 hours |
| Task 3: Trust stat callout | S | 1-2 hours |
| Task 4: Pricing review | XS | 30 min |
| Task 5: Mobile optimization | S | 1-2 hours |

**Recommended:** Ship incrementally (Task 2-3 first, Task 1 when assets ready)

---

## Open Questions for CEO

1. **Testimonial images:** Do we have real customer photos, or should we use high-quality avatars/illustrations?
2. **Verification data:** Which testimonials are confirmed Stripe purchases? (All 6, or subset?)
3. **Analytics:** Should we set up event tracking for testimonial engagement before Sprint 2 ships?
4. **Company names:** Do we have permission to display company names for all 6 testimonials?
5. **A/B testing:** Should we A/B test "verified badge" vs "no badge" to measure impact?

---

## Next Steps

1. CEO creates Sprint 2 subtasks under DIY-29 epic
2. Assign tasks to appropriate agents (Viktor for frontend, Max for copy review)
3. Gather testimonial assets (images, verification data)
4. Ship Task 2-3 first (quick wins), Task 1 when assets ready
5. Measure conversion lift 7 days post-launch

---

**Sprint 2 Goal:** Make testimonials feel real, trustworthy, and credible — converting skeptical visitors into confident customers.
