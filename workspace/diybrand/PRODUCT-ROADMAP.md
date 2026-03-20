# DIYBrand.app Product Roadmap
**Date:** 2026-03-18
**PM:** Sage
**Version:** 1.0

---

## Executive Summary

Based on comprehensive audits (Growth, Design, QA), I've identified **pricing clarity** and **conversion optimization** as the highest ROI opportunities. Performance is below target but not currently blocking users. Design system gaps are manageable technical debt.

**Strategic Focus:** Convert visitors → paid customers. Every feature must drive conversion or retention.

**Status Update (Mar 20, 2026):**
- ✅ Sprint 1: COMPLETE (copy changes, meta tags, CTAs shipped)
- ✅ Sprint 2: MOSTLY COMPLETE (guarantee ✅, comparison ✅, testimonial polish incomplete)
- 🔄 Sprint 3: Backend performance planning complete (DIY-42), frontend optimization pending
- ⏸️ Sprint 4: Design system work deferred

---

## Prioritization Framework

| Priority | Definition | Examples |
|----------|------------|----------|
| **P0** | Blocking revenue/launch | Pricing confusion, payment bugs |
| **P1** | High impact, low effort | Copy improvements, meta tags |
| **P2** | High impact, medium effort | Performance optimization, testimonial upgrades |
| **P3** | Medium impact | Design system improvements |
| **P4** | Low impact/polish | Animation tweaks, scrollbar theming |

---

## Sprint 1: Launch Blockers & Quick Wins (Week 1) — ✅ COMPLETE
**Goal:** Resolve pricing confusion, capture low-hanging conversion wins

### P0 - Critical ✅
| Task | What | Why | How | Effort | Owner | Status |
|------|------|-----|-----|--------|-------|--------|
| **Pricing Clarification** | Confirmed $19/$49 two-tier structure and updated all surfaces | Blocking conversion - conflicting prices destroy trust | 1. CEO alignment ✓<br>2. Updated codebase ✓<br>3. Updated meta tags ✓<br>4. Updated JSON-LD schema ✓ | S | CEO + Dev | ✅ DONE |

### P1 - High Impact Quick Wins ✅
| Task | What | Why | How | Effort | Owner | Status |
|------|------|-----|-----|--------|-------|--------|
| **Hero Headline Rewrite** | Updated headline with benefit-focused copy | Generic headline doesn't differentiate us | Implemented improved headline | XS | Copywriter + Designer | ✅ DONE |
| **Meta Tags Optimization** | Updated title, description, OG tags with USPs | +15% CTR, +20% organic traffic projected | Implemented all meta changes from Growth Audit | S | Dev | ✅ DONE |
| **CTA Copy Improvement** | Updated CTA to "Get My Brand Kit" | More specific, less generic | Updated primary CTA across landing page | XS | Copywriter | ✅ DONE |
| **Pricing Visibility** | Added pricing context throughout site | Pricing clarity needed for conversion | Added $19/$49 tiers to landing, FAQ, export flow | S | Designer + Dev | ✅ DONE |

**Expected Impact:** +10-15% conversion rate, +15% organic CTR
**Actual Impact:** TBD (analytics tracking needed)

---

## Sprint 2: Social Proof & Trust Signals (Week 2) — ✅ MOSTLY COMPLETE
**Goal:** Build credibility, reduce purchase friction
**Status:** Core trust signals shipped (DIY-31, DIY-32, DIY-33). Testimonial polish incomplete (DIY-30 partial).

### P1 - High Impact
| Task | What | Why | How | Effort | Owner | Status |
|------|------|-----|-----|--------|-------|--------|
| **Testimonial Upgrade** | Add profile images, full names, specifics, verification badges | Generic testimonials feel fake - hurts trust | 1. Source real customer data<br>2. Get permission + photos<br>3. Rewrite with specifics (timelines, cost comparisons) | M | Marketing + Designer | ⚠️ PARTIAL (copy ✅, images ❌, badges ❌) |
| **Money-Back Guarantee** | Add explicit 30-day refund guarantee copy | Reduces purchase anxiety | Add guarantee section near pricing tiers | XS | Copywriter | ✅ DONE (DIY-31) |
| **Price Comparison Callout** | Show DIYBrand vs Canva/Adobe costs | Positions $19/$49 as steal, not cheap | Add comparison table below pricing | S | Designer | ✅ DONE (DIY-32) |

### P2 - Medium Impact
| Task | What | Why | How | Effort | Owner | Status |
|------|------|-----|-----|--------|-------|--------|
| **Feature Copy Rewrite** | Rewrite all 6 features benefit-first instead of feature-first | Current copy explains "what" not "why it matters" | Use rewrite examples from Growth Audit | M | Copywriter | ✅ DONE (verified Mar 20) |

**Expected Impact:** +12% conversion rate, +5% time-on-page
**Actual Impact:** Analytics setup needed to measure baseline and lift

---

## Sprint 3: Performance Optimization (Weeks 3-4) — 🔄 APPROVED IN PRINCIPLE
**Goal:** Hit 85+ Lighthouse performance target
**Status:** Approved pending Sprint 2 results. May adjust scope to double down on conversion if Sprint 2 shows strong ROI.

### P2 - High Impact, Medium Effort
| Task | What | Why | How | Effort | Owner |
|------|------|-----|-----|--------|-------|
| **JavaScript Profiling** | Identify slow JS execution | Performance score 64-65, target 85+ | Chrome DevTools profiling → fix bottlenecks | M | Dev |
| **Code Splitting** | Lazy-load non-critical JavaScript | Reduce initial bundle size | Next.js dynamic imports for wizard, success page | M | Dev |
| **Image Optimization** | Convert to WebP, optimize delivery | Faster LCP, better mobile performance | Next.js Image component + WebP conversion | S | Dev |
| **Prefers-Reduced-Motion** | Disable animations for accessibility | Better a11y + performance for low-end devices | CSS media query for all animations | S | Designer + Dev |

**Expected Impact:** Lighthouse score 65 → 85+, better mobile UX, improved accessibility

---

## Sprint 4: Design System Maturity (Weeks 5-6)
**Goal:** Reduce technical debt, enable faster iteration

### P3 - Medium Impact
| Task | What | Why | How | Effort | Owner |
|------|------|-----|-----|--------|-------|
| **Component Library Doc** | Document all reusable components with variants | No single source of truth for design patterns | Create `DESIGN-SYSTEM.md` with component inventory | M | Designer |
| **Standardize Spacing** | Replace hardcoded px values with Tailwind scale | Inconsistent spacing hurts polish | Audit all components, replace with `gap-4`, `p-6` etc | M | Dev |
| **Reusable Spinner Component** | Create Spinner component with size variants | Multiple inconsistent spinner implementations | Centralize spinner logic with props | S | Dev |
| **Button Component** | Create Button.tsx with size/variant props | No clear button hierarchy | Document primary, secondary, ghost, tertiary | S | Designer + Dev |

**Expected Impact:** Faster dev velocity, better consistency, easier onboarding for new devs

---

## Backlog: Future Enhancements

### Short-term (Month 2)
- **Video testimonials** (user-generated content showing kits in use)
- **Competitor comparison page** (dedicated landing page vs Canva, Adobe, Looka)
- **A/B test headline variations** (3 options from Growth Audit)
- **UGC gallery** (customer brand kits showcase)
- **Form validation icon indicators** (visual hierarchy for errors)

### Long-term (Month 3+)
- **Storybook/showcase page** (live component gallery at /design-guide)
- **Design tokens system** (extract CSS vars to dedicated tokens file)
- **Semantic color system** (success/error/warning/info variants)
- **Empty state patterns** (no saved sessions, API errors, etc)
- **Mobile nav/header** (sticky header with logo + CTA)

---

## Success Metrics (Track Post-Launch)

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| **Landing → Questionnaire CTR** | TBD | +15% | Google Analytics |
| **Questionnaire → Payment conversion** | TBD | +10% | Stripe analytics |
| **Avg. time on page** | TBD | +25% | Google Analytics |
| **Organic CTR** | TBD | +15% | Search Console |
| **Lighthouse Performance** | 64-65 | 85+ | Lighthouse CI |
| **Form abandonment rate** | TBD | -20% | Funnel analysis |
| **Testimonial engagement** | TBD | +10% scroll depth | Hotjar/Analytics |

---

## Decision Log

### ✅ Resolved (CEO Decision - Mar 18, 2026)
1. **Pricing model:** $19/$49 two-tier structure (Basic/Premium) — DROP all $14.99 references
2. **Refund policy:** 30 days, no questions asked
3. **Early access status:** Promotional pricing (current $19/$49 is "early access pricing" that will increase post-launch)
4. **"Designed in Sweden":** NOT NOW — revisit in Month 2 (not a conversion driver at this stage)

### Decisions Made
- **Focus on conversion first, performance second** (rationale: perf not blocking users, but poor copy is losing conversions)
- **Sprint 1 prioritizes quick wins** (low effort, high impact changes before bigger lifts) — ✅ COMPLETE
- **Design system work deferred to Sprint 4** (technical debt, not revenue driver)
- **Sprint 2 approved:** Social proof & trust signals (CEO creating subtasks)
- **Sprint 3-4 approved in principle:** Will cut scope if Sprint 2 results show we should double down on conversion

---

## Competitive Intelligence

### Tracked Competitors
- **Looka** - $20 one-time, similar positioning
- **Brandmark** - $25-65 tiers, AI-powered
- **Tailor Brands** - $10.99/mo subscription (our differentiator: no subscriptions)
- **Logo Diffusion** - $10-40, Stable Diffusion based
- **Canva Logo Maker** - $120/yr Canva Pro (locked to Canva)

### Our Advantages
1. ✅ **One-time payment** (no subscriptions = biggest differentiator)
2. ✅ **Own all files** (vs Canva lock-in)
3. ✅ **$19/$49 price point** (Basic tier undercuts Looka $20, Premium competes with Brandmark $25-65)
4. ✅ **Beautiful design** (neon aesthetic stands out)
5. ✅ **Simple UX** (no feature bloat)
6. ✅ **30-day money-back guarantee** (reduces purchase anxiety)

### Gaps to Address
- ⚠️ **Social proof** (competitors have 10K+ reviews, we have 6 testimonials)
- ⚠️ **Brand recognition** (new entrant, no SEO history)
- ⚠️ **Feature parity** (competitors have templates, mockups, business card design)

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Pricing confusion loses customers | HIGH | HIGH | P0 priority in Sprint 1 |
| Performance hurts mobile conversions | MEDIUM | MEDIUM | Address in Sprint 3, monitor bounce rate |
| Neon aesthetic polarizes users | LOW | MEDIUM | A/B test "professional" variant later |
| Generic copy doesn't convert | HIGH | HIGH | Rewrite in Sprint 1+2 |
| Competitor undercuts pricing | LOW | HIGH | Lock in early adopters at $19/$49 forever |

---

## Next Actions (This Week)

### ✅ Completed
- [x] **CEO:** Confirmed final pricing ($19/$49 two-tier structure)
- [x] **Sage (PM):** Updated roadmap with CEO decisions
- [x] **Sage (PM):** Created SPRINT-2-SPEC.md implementation guide
- [x] **Dev:** Updated pricing across FAQ, landing page, export flow
- [x] **Sprint 1:** Completed - copy changes, meta tags, CTAs shipped

### ✅ Sprint 2 Shipped (Week of Mar 18-20)
- [x] **CEO:** Created Sprint 2 subtasks (DIY-30, DIY-31, DIY-32, DIY-33)
- [x] **Dev (Viktor):** Shipped 30-day money-back guarantee badge (DIY-31)
- [x] **Dev (Viktor):** Shipped competitor comparison component (DIY-32)
- [x] **Dev (Viktor):** Updated early access pricing copy (DIY-33)
- [x] **Copywriter:** Upgraded testimonial copy with specifics (DIY-30 partial)

### 🔧 Sprint 2 Polish (Incomplete)
- [ ] **Marketing:** Replace testimonial .svg placeholders with real photos or quality avatars
- [ ] **Designer:** Add verification badges to testimonials (SPRINT-2-SPEC.md Task 2)
- [ ] **Designer:** Add trust stat callout above testimonials (SPRINT-2-SPEC.md Task 3)
- [ ] **Dev:** Add date stamps to testimonials ("Feb 2026", "Mar 2026")

### 🎯 Next Priority (Week of Mar 20-27)
- [ ] **DIY-56 (HIGH):** Set up analytics to measure Sprint 2 impact — blocks Sprint 3 decision
- [ ] **DIY-55 (MEDIUM):** Complete Sprint 2 testimonial polish (images, badges, dates, stats)
- [ ] **DIY-57 (MEDIUM):** Sprint 3 prioritization decision (performance vs conversion vs hybrid)
- [ ] **Atlas (CTO):** Production deployment pending board action on DIY-51-53 (per CEO memory)

### ✅ Completed This Week (Mar 20)
- [x] **Sage (PM):** Audited Sprint 2 completion status (all core features shipped)
- [x] **Sage (PM):** Verified feature copy rewrite (confirmed benefit-focused)
- [x] **Sage (PM):** Created tracking issues for gaps (DIY-55, DIY-56, DIY-57)
- [x] **Sage (PM):** Updated roadmap with Mar 20 status

---

## Notes

- This roadmap assumes **post-MVP, pre-launch** state (early access)
- All efforts are t-shirt sized: XS (<2h), S (<1 day), M (2-3 days), L (1 week), XL (2+ weeks)
- Sprint 1-2 focus on **conversion optimization** (cheapest way to grow revenue)
- Sprint 3-4 focus on **technical quality** (required for scale, not blocking launch)
- Backlog items can be pulled forward if dependencies resolve early

---

**End of Roadmap**
