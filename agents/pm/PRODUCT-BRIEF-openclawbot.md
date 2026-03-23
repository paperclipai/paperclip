# Product Brief: openclawbot.vn

**Project ID:** f0baf11f-3c09-4e4d-b446-eae35b6c5c70
**Status:** In Progress
**PM Owner:** PM (39d9711f-1218-47b8-a31a-34a22930af81)
**Last Updated:** 2026-03-22

---

## 🎯 Product Vision

**Mission Statement:**
OpenClawBot.vn là nền tảng học tập trực tuyến tương tác về AI và công nghệ, được thiết kế để cung cấp trải nghiệm học tập hiện đại với AI chatbot hỗ trợ, presentations tương tác, và quản lý tiến trình cá nhân hóa.

**Target Audience:**
- Sinh viên và chuyên gia công nghệ tại Việt Nam
- Người học muốn tìm hiểu về AI, Claude, và agentic workflows
- Developers muốn áp dụng AI vào công việc thực tế

**Value Proposition:**
- ✅ Nội dung bilingual (EN/VN) chất lượng cao
- ✅ Interactive presentations với enrichment content (readmore, examples, quizzes)
- ✅ AI chatbot hỗ trợ học tập 24/7 (powered by Gemini)
- ✅ Progress tracking cá nhân hóa
- ✅ Static site = fast, reliable, cost-effective

---

## 📊 Current State Assessment

### Technical Stack
- **Framework:** Astro v5.17.1 (static site generator)
- **Language:** TypeScript
- **Deployment:** Netlify + serverless functions
- **AI Integration:** Google Gemini API (chatbot)
- **Auth:** Google OAuth (client-side)

**Overall Grade:** B+ (Good foundation với critical security concerns)

### Live Features
1. ✅ **Interactive Presentations**
   - 35 slides về Claude Cowork
   - Enrichment content: readmore, examples, quizzes
   - Bilingual EN/VN support

2. ✅ **AI Chatbot**
   - Gemini-powered assistant
   - Context-aware responses
   - Sidebar interface

3. ✅ **Learning Materials**
   - Video player integration
   - Manga reader for creative content
   - PDF resources

4. ✅ **Progress Tracking**
   - Local storage-based progress
   - Google OAuth integration
   - User profiles

### Recent Deliverables
- **QUA-185 (done):** Comprehensive code & UI review completed
  - Identified 15 action items across security, performance, A11y, SEO
  - 5-phase improvement plan defined
- **QUA-187 (in_review):** Claude Cowork enrichment content
  - 140 content entries (35 slides × 2 types × 2 languages)
  - Ready for CTO review

---

## 🚨 Critical Issues (Active Risk)

### Security (CRITICAL - P0)
1. **Exposed API Keys** - GEMINI_API_KEY committed to repo
2. **CORS Wildcard** - gemini-proxy allows any origin = cost abuse risk
3. **XSS Vulnerabilities** - innerHTML patterns without sanitization
4. **OAuth Security** - No PKCE, no state validation, no token expiry

**Impact:** Site vulnerable to attacks, API abuse, data leaks
**Action Required:** Immediate rotation + security hardening

### Quality (HIGH - P1)
5. **No Test Coverage** - Only 1 broken test file, zero unit tests
6. **11MB PDF** - Performance bottleneck for users
7. **Missing Security Headers** - No CSP, X-Frame-Options

**Impact:** Poor quality assurance, slow load times, SEO penalties

### User Experience (MEDIUM - P2)
8. **Image Optimization** - No srcset, lazy loading, or WebP
9. **SEO Gaps** - Missing og:image, twitter:card, JSON-LD
10. **A11y Issues** - No focus trap in modals, missing aria-modal

**Impact:** Suboptimal user experience, lower search rankings

---

## 📈 Success Metrics (Proposed)

### Product Health KPIs
| Metric | Current | Target Q1 | Measurement Method |
|--------|---------|-----------|-------------------|
| **Security Grade** | D | A | Security audit checklist |
| **Test Coverage** | 0% | 60%+ | Vitest coverage report |
| **Page Load (LCP)** | ~2.5s | <2.0s | Lighthouse CI |
| **A11y Score** | 78/100 | 90+/100 | axe DevTools audit |
| **SEO Score** | 85/100 | 95+/100 | Lighthouse SEO |

### User Engagement KPIs (Post-Analytics Setup)
- **DAU/MAU Ratio** - Target: 0.3+ (sticky users)
- **Presentation Completion Rate** - Target: 60%+
- **Chatbot Interaction Rate** - Target: 40% of sessions
- **Avg Session Duration** - Target: 8+ minutes

### Business Impact KPIs
- **Gemini API Cost per User** - Optimize to <$0.10/session
- **Uptime** - Target: 99.9% (Netlify SLA)
- **Zero Security Incidents** - P0 goal

---

## 🗺️ Product Roadmap

### Phase 1: Security & Stability (CRITICAL - Week 1-2)
**Status:** Planned (awaiting CTO delegation)

**Deliverables:**
- [ ] Rotate exposed API keys, clean git history
- [ ] Fix CORS policy (restrict to openclawbot.vn)
- [ ] Sanitize all innerHTML patterns (XSS mitigation)
- [ ] Add HTTP security headers (CSP, X-Frame-Options)
- [ ] Implement OAuth security (PKCE, state validation)

**Success Criteria:**
- Security audit passes with A grade
- No exposed secrets in codebase
- OWASP top 10 vulnerabilities addressed

**Owner:** SA1 (Security Lead)
**Timeline:** 3-5 days

---

### Phase 2: Quality & Performance (HIGH - Week 3-4)
**Status:** Backlog

**Deliverables:**
- [ ] Add unit tests for core functions (storage.js, auth)
- [ ] Compress 11MB PDF or split into volumes
- [ ] Image optimization (srcset, lazy loading, WebP)
- [ ] Fix broken test file, achieve 60%+ coverage
- [ ] Add CI/CD test gates

**Success Criteria:**
- Test coverage ≥60%
- Page load time <2.0s (LCP)
- All images optimized (WebP + lazy)

**Owner:** SA2 (Code Quality)
**Timeline:** 5-7 days

---

### Phase 3: SEO & Accessibility (MEDIUM - Week 5-6)
**Status:** Backlog

**Deliverables:**
- [ ] Add JSON-LD structured data
- [ ] Create OG images for social sharing
- [ ] Fix focus management in modals
- [ ] Add aria-modal, focus trap for chatbot
- [ ] A11y audit with axe DevTools

**Success Criteria:**
- SEO score 95+/100
- A11y score 90+/100
- Rich snippets in Google search

**Owner:** UI/UX Designer + QA Tester
**Timeline:** 4-6 days

---

### Phase 4: Code Quality & Refactoring (LOW - Week 7-8)
**Status:** Backlog

**Deliverables:**
- [ ] Remove 9 dead redirect stubs
- [ ] Refactor duplicate presentation files
- [ ] Extract subcomponents from 1205-line presentation.astro
- [ ] Migrate storage.js to TypeScript
- [ ] Clean up magic numbers/strings

**Success Criteria:**
- Code maintainability score A
- Zero duplicate code >100 lines
- TypeScript coverage 100%

**Owner:** SA (any available)
**Timeline:** 3-5 days

---

### Phase 5: New Features (FUTURE)
**Status:** Ideation

**Potential Features:**
- 🔮 Real-time progress sync (replace localStorage with backend)
- 🔮 Social features (comments, Q&A on presentations)
- 🔮 Adaptive learning paths (AI-recommended next content)
- 🔮 Certificates & achievements system
- 🔮 Multi-language support beyond EN/VN (JP, CN, FR)
- 🔮 Mobile app (React Native wrapper)

**Prioritization Criteria:**
- User demand (feedback from CEO/stakeholders)
- Technical feasibility
- Resource availability
- Strategic alignment with company goals

---

## 🎯 Definition of Done (DoD)

For any feature or fix to be considered "done":

### Code Quality
- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] All tests pass (`npm test`)
- [ ] Code coverage ≥60% for new code
- [ ] No eslint warnings
- [ ] PR reviewed and approved by CTO or SA Lead

### Security
- [ ] No exposed secrets or API keys
- [ ] Input validation at all boundaries
- [ ] OWASP top 10 vulnerabilities checked
- [ ] Security headers present

### Performance
- [ ] Lighthouse Performance score ≥90
- [ ] LCP <2.5s, FID <100ms, CLS <0.1
- [ ] Images optimized (WebP, lazy, srcset)

### Accessibility
- [ ] Lighthouse A11y score ≥90
- [ ] Keyboard navigation works
- [ ] Screen reader tested (basic flow)
- [ ] ARIA labels correct

### Deployment
- [ ] Deployed to Netlify staging
- [ ] Smoke test passed (auth, chatbot, presentations)
- [ ] No console errors in production
- [ ] CTO approval before production deploy

---

## 📋 Backlog Management

### Current Sprint Focus
- **QUA-187:** Awaiting CTO review (Claude Cowork content)
- **Security Phase 1:** Pending CTO delegation to SA1

### Upcoming Work (Prioritized)
1. **P0 - CRITICAL:** Security fixes (API keys, CORS, XSS, OAuth)
2. **P1 - HIGH:** Testing infrastructure, PDF optimization
3. **P2 - MEDIUM:** SEO & A11y improvements
4. **P3 - LOW:** Code refactoring, cleanup

### Backlog Grooming Cadence
- **Weekly:** PM reviews backlog with CTO
- **Biweekly:** Prioritization review based on user feedback
- **Ad-hoc:** Emergency issues (security, critical bugs)

---

## 👥 Team & Responsibilities

### Product Leadership
- **PM (39d9711f):** Product strategy, roadmap, backlog management, stakeholder communication
- **CTO (947b6984):** Technical decisions, security oversight, code review, final approval

### Execution Team
- **SA1 (Tech Lead):** Security fixes, architecture, complex features
- **SA2-SA5:** Feature development, bug fixes, code quality
- **UI/UX Designer:** Design system, accessibility, user experience
- **QA Tester:** Test coverage, quality assurance, validation

---

## 🔄 Communication & Cadence

### Sync Points
- **Daily:** Agent heartbeats (async status updates)
- **Weekly:** PM → CTO product sync (priorities, blockers)
- **Biweekly:** Retrospective (what worked, what didn't)
- **On-demand:** Critical issues escalation

### Reporting Format
- **Heartbeat:** HEARTBEAT.md updates
- **Issues:** Paperclip issue tracker (QUA-xxx)
- **Decisions:** Documented in issue comments
- **Specs:** Using template from QUA-176

---

## 📊 Risk Register

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|-------------------|
| API key abuse (already exposed) | High | Critical | Immediate rotation + CORS fix |
| Security breach (XSS, auth bypass) | Medium | Critical | Phase 1 security hardening |
| Gemini API cost spike | Low | High | Rate limiting + usage monitoring |
| No test coverage = regression bugs | High | Medium | Phase 2 testing infrastructure |
| SEO ranking drop | Low | Medium | Phase 3 SEO optimization |
| Agent capacity bottleneck | Medium | Medium | Cross-train agents, prioritize ruthlessly |

---

## 📝 Appendices

### Related Documents
- **SDLC Process:** `/Users/quanghung/Documents/paperclip/docs/plans/sdlc-flowchart.md`
- **Spec Template:** `/Users/quanghung/Documents/paperclip/docs/templates/spec-template.md`
- **PM Initiatives:** `/Users/quanghung/Documents/paperclip/agents/pm/PM-INITIATIVES.md`

### Issue References
- **QUA-185:** [Review source code] - Completed with action plan
- **QUA-187:** [Update Claude Cowork content] - In review
- **QUA-196:** [PM Initiatives] - Awaiting CTO feedback

### External Links
- **Live Site:** https://openclawbot.vn/
- **Netlify Dashboard:** (access via hungdqdesign@gmail.com)
- **Repo:** /Users/quanghung/Documents/openclawbotvn

---

**Document Status:** ✅ Draft Complete - Ready for CTO Review
**Next Review:** After Phase 1 completion
**Version:** 1.0 (2026-03-22)
