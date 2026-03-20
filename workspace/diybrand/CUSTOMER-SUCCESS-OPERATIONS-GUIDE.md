# Customer Success Operations Guide
**Launch Day & First 30 Days**

**Owner:** Echo (Customer Success Lead)
**Date:** 2026-03-20
**Purpose:** Operational guidance for support team during launch and first month

---

## Quick Navigation

- **Pre-Launch:** [48-hour customer success checklist](#pre-launch-48-hours-before)
- **Launch Day:** [Support team handoff & monitoring](#launch-day-morning-preparation)
- **First 24 Hours:** [Incident response & triage](#post-launch-first-24-hours)
- **First Week:** [Customer success metrics & issues](#launch-week-ongoing-monitoring)
- **First Month:** [Feedback patterns & documentation updates](#first-30-days)

---

## Pre-Launch (48 hours before)

### Customer Success Infrastructure Final Check

**Timeline:** 1 hour
**Owner:** Support team lead

#### Step 1: Verify All Customer-Facing Pages
```
Checklist:
☐ FAQ page loads and search works (/faq)
☐ How-To Guides page loads (/guides)
☐ Refund Policy page visible in footer (/refund-policy)
☐ Privacy Policy page accessible (/privacy)
☐ Terms of Service page accessible (/terms)
☐ Footer links all working (Help, Product, Company sections)
☐ Pricing shown correctly ($19 Basic / $49 Premium)
```

**Test Steps:**
1. Open each page on mobile, tablet, desktop
2. Verify search functionality on FAQ page
3. Click all footer links
4. Check that pricing is consistent across pages

#### Step 2: Verify Feedback System
```
Checklist:
☐ Success page loads (/success)
☐ Feedback widget visible after export
☐ Star rating system works (1-5 stars)
☐ Comment field accepts text
☐ Submit button functional
☐ Success message shows after submission
```

**Test Steps:**
1. Complete a test purchase → download brand kit
2. Verify feedback widget appears
3. Submit test feedback (all ratings from 1-5)
4. Verify submission completes without errors

#### Step 3: Email System Ready
```
Checklist:
☐ support@diybrand.app inbox accessible
☐ Team members have email access
☐ Welcome email template saved as draft
☐ Common response templates saved (8 templates)
☐ Unsubscribe links working in email templates
☐ Email addresses for team members verified
```

#### Step 4: Support Tools Prepared
```
Checklist:
☐ SUPPORT-TEMPLATES.md printed/available
☐ FAQ memorized or quick reference prepared
☐ Refund process (5 steps) understood by all staff
☐ Escalation contacts documented (who to contact for product bugs)
☐ Support SLA defined (target: respond within 24 hours)
☐ Backup support person assigned
```

---

## Launch Day: Morning Preparation

**Timeline:** 30 minutes before launch (T-30)
**Owner:** Support team lead

### Support Team Standup

Before launch goes live, confirm:

1. **Team Status**
   - Who is monitoring support email (primary + backup)?
   - Who is responding to feedback widget submissions?
   - Who is monitoring FAQ searches/analytics?
   - What are working hours? (24/7 or business hours?)

2. **Communication Plan**
   - Where will team post urgent updates? (Slack, Discord, email?)
   - How will product bugs be reported to dev team?
   - How will refund requests be escalated?
   - Who is the point person for unplanned issues?

3. **First Customer Protocol**
   - First customer email gets personal welcome (not template)
   - Personalized message acknowledging their purchase
   - Link to guides if they ask questions
   - Thank them and ask for feedback on experience

### Systems Monitoring (T-0 onwards)

**Every 15 minutes for first hour:**
- [ ] Check support@diybrand.app for incoming emails
- [ ] Check feedback widget submissions (via /api/feedback or dashboard)
- [ ] Check website uptime (is /faq loading? /guides? /success page?)
- [ ] Note first customers' names and products (brand names if shared)

**Every hour for first 24 hours:**
- [ ] Tally support emails received (target: 0-2 in first 8 hours)
- [ ] Review feedback ratings (target: 4.0+ average)
- [ ] Scan FAQ search logs for unexpected queries
- [ ] Check Sentry/error logs for customer-facing errors

---

## Post-Launch: First 24 Hours

### Customer Success Triage & Response

**Priority 1: Incoming Emails** (respond within 1 hour)
- Customer can't download files → [Download Issues Template](SUPPORT-TEMPLATES.md#file-export-issues)
- Pricing question → [Pricing Template](SUPPORT-TEMPLATES.md#quick-start) + link to FAQ
- Refund request → Follow [Refund Process](#refund-request-process) below
- Product bug report → Collect details, escalate to dev team, respond with workaround if available

**Priority 2: Feedback Widget Ratings** (review every 4 hours)
- Rating 5 stars + positive comment → Save as testimonial idea
- Rating 1-3 stars → Read comment carefully, reply if email provided, flag for product improvement
- No comment, just rating → Log the trend

**Priority 3: Unusual Patterns** (escalate immediately)
- Multiple customers reporting same issue → Product bug, escalate
- FAQ searches for "refund" spiking → Something is wrong, investigate
- Success page not loading → Website issue, escalate to Atlas
- Feedback widget not submitting → Check API status, escalate if broken

### Refund Request Process

When customer requests refund via email:

```
Step 1: Acknowledge receipt within 24 hours
  → "Thanks for reaching out. We'll process your refund request."
  → Link to Refund Policy (/refund-policy)

Step 2: Verify purchase date
  → Check if within 30-day window
  → Check Stripe for transaction timestamp

Step 3: Check purchase history
  → Is this their first purchase? (sometimes they need help, not refund)
  → Have they reached out before? (pattern?)
  → Is there an obvious product issue?

Step 4: Decide refund vs. support
  → If ISSUE: offer solution first ("Have you tried...?")
  → If REFUND ELIGIBLE: "Yes, I'll process your refund immediately"
  → If OUTSIDE WINDOW: "Your purchase was >30 days ago, but let's try to help"

Step 5: Process refund in Stripe
  → Issue full refund to original payment method
  → Note reason: "Customer request - refund approved"
  → Email confirmation: "Refund processed. Appears in account in 3-5 business days."

Step 6: Document and follow up
  → Save email in archive
  → Note why they requested refund (for product team)
  → Check if FAQ addresses this issue
```

---

## Launch Week: Ongoing Monitoring

**Daily Tasks (same time each day)**

### Morning Standup (9 AM)
- [ ] Check overnight support emails (if 24/7) or all new emails
- [ ] Tally feedback widget submissions from yesterday
- [ ] Review any error reports in Sentry
- [ ] Identify patterns: common questions, common issues
- [ ] Post standup update to team Slack/Discord

**Tally Sheet (use this format):**
```
[Date] Daily Summary:
- Support emails received: [#]
- Feedback submissions: [#]
- Average rating: [#.#/5]
- Refund requests: [#]
- New FAQ items needed: [list or "none"]
- Product issues reported: [list or "none"]
- Status: [Green/Yellow/Red]
```

### Midday Check (12 PM)
- [ ] Respond to any pending support emails
- [ ] Check feedback widget analytics if dashboard exists
- [ ] Note any patterns emerging
- [ ] Reply to 1-star feedback if email provided

### End of Day Review (5 PM)
- [ ] Verify all support emails have responses
- [ ] Flag any unresolved issues
- [ ] Document any product bugs found
- [ ] Prepare escalation list for product team (if needed)

---

## First 30 Days: Feedback Loop & FAQ Updates

### Weekly Review (Every Monday)

**Purpose:** Identify patterns and update documentation

**Steps:**

1. **Email Analysis**
   - What questions came up most? (tally)
   - What product issues were reported? (list)
   - What did customers struggle with? (note patterns)

2. **Feedback Rating Analysis**
   - Average rating for the week
   - Trend (is it improving or declining?)
   - Common words in negative feedback (search for patterns)

3. **FAQ Gap Analysis**
   - What email questions could have been answered by FAQ?
   - What new FAQ items should be added?
   - What guide topics need more detail?

4. **Action Items**
   - Update FAQ with new Q&A from support emails (Echo updates)
   - Update guides if customers struggled with steps (Echo updates)
   - Report product bugs to dev team with customer details
   - Send thank-you emails to customers who left positive feedback

### Monthly Metrics Review (End of Month)

**Success Metrics Dashboard:**
```
Target Metric          | Target       | Actual | Status
-----------------------|--------------|--------|--------
Support emails         | <20 total    | ___    | ☐ ☐ ☐
Support response time  | <24 hours    | ___    | ☐ ☐ ☐
Avg feedback rating    | 4.5+/5       | ___    | ☐ ☐ ☐
Refund rate            | <5%          | ___    | ☐ ☐ ☐
FAQ searches/visitor   | >30%         | ___    | ☐ ☐ ☐
Feedback response rate | >20%         | ___    | ☐ ☐ ☐
FAQ useful rating      | N/A          | ___    | ☐ ☐ ☐
```

**Review Questions:**
- Are customers finding answers without emailing support?
- What patterns emerged that need product changes?
- Are email templates effective? (update if needed)
- Do guides match how customers actually use the product?
- Are we achieving zero-support-ticket goal? (any preventable tickets?)

---

## Critical Customer Success Workflows

### Workflow 1: Customer Has a Question

```
Customer Action:
1. Arrives at DIYBrand site
2. Sees footer with "Help" section
3. Clicks FAQ or Guides

Expected Outcome:
→ Finds answer without emailing support
→ Problem solved, no support ticket

What We Track:
- Did they visit FAQ first? (analytics)
- Did FAQ answer their question? (feedback)
- If they still emailed support after reading FAQ → FAQ failed
```

### Workflow 2: Customer Needs Help (Email Support)

```
Customer Action:
1. Visits FAQ → doesn't find answer
2. Looks at Guides → still stuck
3. Clicks email support link or finds support@diybrand.app

Support Response:
1. Within 24 hours, receive response
2. Response uses relevant template
3. Response links to FAQ/Guides when applicable
4. Issue is resolved via email or documented for product

Expected Outcome:
→ Customer feels heard and helped
→ Issue resolved OR
→ Product bug logged for dev team

What We Track:
- Response time (target: <24 hours)
- Did template solve issue? (follow-up check)
- Did this reveal FAQ gap? (update FAQ)
```

### Workflow 3: Customer Rates Feedback Widget

```
Customer Action:
1. Exports brand kit (success page)
2. Sees feedback widget
3. Rates 1-5 stars and optionally adds comment

Support Action:
- 5 stars → Archive as testimonial candidate
- 4 stars → Note what worked well
- 3 stars → Check for issues
- 1-2 stars → Investigate immediately
  - If email provided → Reply with offer to help
  - If they mention issue → Escalate to dev team
  - If unclear → Ask what they'd improve

Expected Outcome:
→ Identify product issues early
→ Collect testimonials
→ Show customers we listen
```

### Workflow 4: Customer Requests Refund

```
Customer Action:
1. Decides to request refund within 30 days
2. Emails support@diybrand.app with request
3. May or may not state reason

Support Action:
1. Acknowledge within 24 hours
2. Ask why (if not stated) — is it product issue or expectation issue?
3. If product issue → offer fix first, refund if they still want it
4. If expectation mismatch → offer guidance before refunding
5. If genuine dissatisfaction → process refund within 2 business days
6. Document reason for product team

Expected Outcome:
→ Customers know we honor our 30-day guarantee
→ Product team learns what to improve
→ Refund rate stays <5%
```

---

## Escalation Matrix

**When to escalate to product/dev team:**

| Issue | Escalate If | Escalate To |
|-------|-------------|------------|
| Customer can't export | Happens to 2+ customers | Atlas/DevOps |
| Pricing confusion | Happens to 3+ customers | CEO (may need product clarification) |
| Feature question | Requests unavailable feature | CEO/Product |
| Product bug | Any reproducible bug | Dev team (GitHub issue) |
| Security issue | Any data/privacy concern | CEO immediately |
| Stripe issue | Payment not processing | Atlas (Stripe integration) |
| Website down | Success page won't load | Atlas (website status) |

---

## Templates & Resources

Quick reference for support team:

- **Support Email Templates:** [SUPPORT-TEMPLATES.md](SUPPORT-TEMPLATES.md) (8 professional responses)
- **FAQ Page:** [/faq](/faq) (50+ answers, searchable)
- **How-To Guides:** [/guides](/guides) (6 step-by-step guides)
- **Refund Policy:** [/refund-policy](/refund-policy) (30-day guarantee, clear process)
- **Customer Success Strategy:** [CUSTOMER-SUCCESS-STRATEGY.md](CUSTOMER-SUCCESS-STRATEGY.md) (philosophy & workflows)
- **Pricing & Features:** See FAQ or [LAUNCH-STATUS-ECHO.md](LAUNCH-STATUS-ECHO.md)

---

## Key Success Numbers

If these happen in first 30 days, customer success is working:

✅ **Fewer than 20 support emails** (most customers self-serve via FAQ/guides)
✅ **Average feedback rating 4.5+/5 stars** (customers are satisfied)
✅ **Refund requests <5%** (low refund rate = product/expectation match)
✅ **Support response time <24 hours** (customers feel heard)
✅ **FAQ page searches >100/week** (customers finding answers)
✅ **30%+ of visitors check FAQ before emailing** (self-service working)

---

## Hand-Off from Echo (Customer Success Lead)

**What You're Inheriting:**
- 5 live customer-facing pages (FAQ, Guides, Refund Policy, Privacy, Terms)
- Feedback collection system (widget + API + database)
- 8 professional support email templates
- 10-email onboarding sequence (ready for automation tool)
- Customer success strategy and philosophy

**Your Responsibilities:**
- Monitor support inbox daily
- Respond to customer emails within 24 hours
- Review feedback ratings and patterns
- Update FAQ based on support emails
- Track success metrics
- Escalate product bugs and critical issues

**Philosophy:**
*Every support email is a documentation failure. Your job is to fix the docs so the next customer doesn't email support.*

When you get an email question that's already answered in the FAQ → that's a red flag. The FAQ didn't help that customer. Fix the FAQ to be clearer.

**Success Looks Like:**
- Support email volume <20/month by month 2
- FAQ searches growing week over week
- Feedback ratings consistently 4.5+/5
- Zero repeat questions (once answered, it's in FAQ)
- Customers saying "I found the answer on your FAQ"

---

**Questions?** Reach out to @Echo in Paperclip
**Last Updated:** 2026-03-20
**Status:** Ready for Launch
