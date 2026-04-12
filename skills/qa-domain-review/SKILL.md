---
name: qa-domain-review
description: Domain-aware QA review protocol with enterprise-grade SEO and AI SEO auditing. Detects whether work involves web-facing content (triggers SEO/AI SEO review), email content (triggers deliverability check), or neither. Includes March 2024 Google core update alignment, E-E-A-T validation, topical authority clustering, and AI content authenticity detection.
---

# QA Domain Review

Before every QA review, determine whether the work involves web-facing content, email content, or neither. This detection runs first—before any functional testing—because it decides which review tracks to include.

## Detection Logic

Run these checks against the issue description, work products, and any URLs in the PR/branch:

### 1. Web-facing content?

**Triggers SEO + AI SEO review** if ANY of these are true:
- Work product includes a URL on a public domain (viraforgelabs.com, viracue.ai, prsecurelogistics.com, or any custom domain)
- Issue title or description mentions: blog post, landing page, marketing page, article, homepage, product page, pricing page, about page, documentation site, changelog page, public-facing page, content update, blog refresh
- PR title contains keywords: "SEO", "blog", "content", "page optimization"

**Does NOT apply to:**
- Internal dashboards and admin panels
- API endpoints (REST, GraphQL, webhooks)
- Paperclip UI (board views, agent config)
- Developer tools, CLI output, terminal interfaces
- Pages behind authentication that are not indexed
- Status pages, error pages (404, 500)

### 2. Email content?

**Triggers email deliverability review** if ANY of these are true:
- Work involves a Loops template, Mailchimp campaign, SendGrid template, or any ESP template
- Issue mentions: cold email, Gmail campaign, transactional email, lifecycle sequence, newsletter, drip campaign, welcome email, onboarding email, re-engagement email, abandoned cart email, promotional email
- Code changes include email HTML templates or email-sending logic

**Does NOT apply to:**
- Internal agent-to-agent notifications
- System alerts and monitoring emails
- Git commit notification emails
- Paperclip issue comment notifications

### 3. Neither?

Standard QA only. Skip both specialized tracks.

---

## SEO Review Track

When web-facing content is detected, run these checks in addition to functional QA.

### SEO Blocking Failures (Mark QA: FAIL)

Any one of these means the page **must not ship**:

| Check | Threshold | Why It Matters |
|-------|-----------|---|
| Missing meta title | `<title>` tag absent or empty | No SERP snippet; 0 CTR baseline |
| Duplicate meta title | Same `<title>` as another page on the site | Duplicate content signal; diffuses ranking equity |
| No H1 tag | Page has zero `<h1>` elements | No semantic structure; Google can't identify page topic |
| Multiple H1 tags | Page has more than one `<h1>` element | Confuses keyword relevance signals |
| Missing meta description | `<meta name="description">` absent or empty | 30-50% CTR loss even at rank #1-3 |
| Images missing alt text | More than 30% of `<img>` tags lack `alt` attribute (stricter than before) | Breaks image SEO; fails accessibility; penalizes Core Web Vitals |
| Blog/article under 300 words | Main content body (excluding nav, footer, sidebar) has fewer than 300 words | Insufficient depth for topic authority; Google's March 2024 update penalizes thin content |
| Page returns non-200 | HTTP status is not 200 for a page that should be live | Broken indexing; waste crawl budget |
| Accidental noindex | `<meta name="robots" content="noindex">` on a page that should be indexed | Deliberately hides page from search; rank impossible |
| Heading hierarchy broken | H3 appears before H2, or any level skip (H1 → H3) | Confuses semantic structure; harms readability and schema parsing |
| Missing canonical tag | `<link rel="canonical">` absent on ANY URL variant (with params, trailing slash, protocol) | Duplicate content risk; equity dilution |

---

### SEO Warnings (Note in QA Comment, Do Not Block)

| Check | Threshold | Impact |
|-------|-----------|--------|
| Meta title length | Under 30 or over 60 characters | Truncation in SERP; incomplete messaging |
| Meta description length | Under 120 or over 160 characters | Truncation in SERP; incomplete value prop |
| Readability grade | Flesch-Kincaid grade > 12 | Reduces engagement; penalizes time-on-page metrics |
| Content depth (blog) | 300-600 words | Thin for competitive keywords; supplement with internal links |
| Missing internal links | Page has zero links to other pages on same domain (except homepage) | No equity distribution; missed topical clustering |
| Missing schema markup | No JSON-LD or microdata on article, product, FAQ, or recipe pages | No featured snippet eligibility; less rich data in SERP |
| No OG / Twitter Card meta | Missing `og:title`, `og:description`, `og:image`, `twitter:card` | Social shares use fallback text/image; lower engagement |
| LCP > 2.5 seconds | Largest Contentful Paint exceeds 2.5s | Core Web Vitals penalty (July 2024+ ranking factor) |
| FID/INP > 100ms | First Input Delay or Interaction to Next Paint slow | Mobile frustration; lower engagement; ranking penalty |
| CLS > 0.1 | Cumulative Layout Shift exceeds 0.1 | Poor UX; mobile users bounce; ranking penalty |
| No robots.txt entry | Page not explicitly allowed in robots.txt for domains with many URLs | Wasted crawl budget; slow indexing |
| Outbound link anchor text | Links to external domains use generic anchors ("click here", "link") | Missed semantic signals; looks like spam |
| Page load time (mobile) | > 3.5 seconds on 4G | Mobile-first indexing penalty; high bounce rate |
| Author attribution missing | Blog post has no byline or author bio (for new/major rewrites) | E-E-A-T signal loss; appears AI-generated |

---

### AI SEO Audit (New Pages or Major Rewrites Only)

When a new blog post or major content rewrite ships, run these checks to detect whether content is **AI-native synthetic** (generic) vs. **human-first research + AI polish** (authoritative):

#### Authenticity Red Flags (⚠️ = content needs human review before publishing)

| Red Flag | Detection | Severity |
|----------|-----------|----------|
| Generic positioning | "Both have pros/cons" without taking a stance; balanced consensus; no contrarian take | 🔴 High |
| No proprietary data or case studies | Zero metrics from actual customers, product usage, or internal testing | 🔴 High |
| Missing data origin story | "Here are 10 best practices" without explaining WHERE they come from (your product? industry research? aggregate findings?) | 🔴 High |
| Repetitive structure | Every section follows identical problem→response→example format with zero exceptions or nuance | 🟡 Medium |
| No failure modes or edge cases | Advice works perfectly every time; never mentions "here's when this breaks" or "the exception is..." | 🟡 Medium |
| Persona-less author | "Editorial Team", "Company", "We" with no named person; no LinkedIn profile; no credential link | 🟡 Medium |
| Generic examples | Hypothetical calls ("imagine a buyer says...") instead of real customer scenarios or anonymized transcripts | 🟡 Medium |
| No contradictions or complexity | Reads as neutral analyst, not someone who built the product or has war stories | 🟡 Medium |
| Keyword over-optimization in headings | H2/H3 tags are keyword-stuffed (e.g., "H2: Cold Call Scripts for Cold Calling Cold Calls") | 🟡 Medium |
| Missing psychological depth | Advice is tactical without explaining human behavior or decision science | 🟠 Low |
| No benchmarks | No "normal" or "good" threshold; advice lacks calibration | 🟠 Low |

#### Authenticity Green Flags (✅ = content has strong E-E-A-T signals)

| Green Flag | Signal | Weight |
|-----------|--------|--------|
| Named author + LinkedIn profile | Byline with full name, title, and LinkedIn URL that validates expertise | ⭐⭐⭐⭐⭐ |
| Proprietary dataset disclosed | "We analyzed X customer calls/data points and found..." | ⭐⭐⭐⭐⭐ |
| Customer metrics with context | "Morgan Patel (Northfield Tech) saw 19% lift in 3 weeks. Here's why..." | ⭐⭐⭐⭐⭐ |
| Contradiction or nuance | "This approach works EXCEPT when..." or "We originally thought X, but discovered Y" | ⭐⭐⭐⭐ |
| Failure mode discussion | "Here's where reps typically break this technique..." or "The exception is..." | ⭐⭐⭐⭐ |
| Specific call transcripts or examples | Real dialogue (anonymized), not hypothetical | ⭐⭐⭐⭐ |
| Behavioral science or psychological explanation | "Silence triggers discomfort; most reps fill 4 seconds of quiet. Here's why that costs deals..." | ⭐⭐⭐⭐ |
| Competitive positioning | "Gong does X; we chose Y because..." (transparent, not evasive) | ⭐⭐⭐ |
| Research methodology paragraph | "These findings come from 3 years of customer call recordings, isolating moments where reps freeze" | ⭐⭐⭐ |
| Transparent AI disclosure (if applicable) | "Written by [Name] with AI research assistance" | ⭐⭐⭐ |

#### AI SEO Scoring for Content Authenticity

**After auditing red/green flags, score the piece:**

- **8.5-10/10 (Publish, no changes)**: 4+ green flags, 0 red flags. Content has clear proprietary voice and data.
- **7.0-8.4/10 (Publish with minor improvements)**: 2-3 green flags, 0-1 medium red flags. Add author byline and 1 customer metric, ship.
- **5.5-6.9/10 (Conditional publish with revisions)**: 1-2 green flags, 1-2 medium red flags. Require: named author, data origin story, one customer example. Blocking.
- **< 5.5/10 (Do not publish)**: Thin content, no proprietary signal, generic AI synthesis. Send back for major rewrite.

---

### Topical Authority & Internal Linking Audit

For blog posts in a topic cluster (e.g., sales coaching, cold calling, objection handling):

1. **Is this post part of a defined cluster?** (Yes/No)
   - If Yes: Check that it links back to the **pillar post** (main 4k+ word guide) and **2-3 sibling posts**
   - If No: Flag for linking strategy review—isolated posts don't build topical authority

2. **Internal link equity distribution:**
   - Pillar post should receive 70%+ of internal links from cluster posts
   - Cluster posts should link to pillar + 1-2 sibling posts (not each other bidirectionally)
   - Measure: Count inbound links per URL; pillar should have 10+, cluster posts 2-4

3. **Canonical tag consistency:**
   - All URLs in the cluster must have self-referential canonical tags: `<link rel="canonical" href="https://viracue.ai/blog/this-exact-url">`
   - If pillar post exists, cluster posts should canonical to THEMSELVES, not the pillar (they're separate ranking targets)

---

### Core Web Vitals & Performance Audit

For **new pages only** (major redesigns), test against Google's Core Web Vitals thresholds (as of July 2024):

| Metric | Good | Needs Work | Poor |
|--------|------|-----------|------|
| **LCP** (Largest Contentful Paint) | ≤ 2.5s | 2.5s–4.0s | > 4.0s |
| **FID** (First Input Delay) | ≤ 100ms | 100ms–300ms | > 300ms |
| **CLS** (Cumulative Layout Shift) | ≤ 0.1 | 0.1–0.25 | > 0.25 |

**Audit method**: Use PageSpeed Insights (free) or WebVitals API. Test on **mobile** (mobile-first indexing).

**Blocking threshold**: If LCP > 3.5s on mobile, flag for performance optimization before shipping.

---

## Email Deliverability Track

When email content is detected, use the **email-deliverability** skill to run the full check. That skill covers:

- SpamCheck API scoring via Postmark (free, no auth)
- Blocking failure checklist (spam score, CAN-SPAM compliance, merge variables, freemail domains)
- Warning checklist (subject line quality, preview text, plain text alternative, link safety)
- SpamAssassin rule lookup table
- Reporting format

Do not duplicate the email-deliverability skill content here. Reference it and include its output in the QA comment under the Email Deliverability section.

---

## QA Comment Format

Structure the QA comment with up to four sections. Only include sections that apply.

```markdown
## QA Review -- [ISSUE-ID]

### Functional Testing

**Test environment:** [URL or environment description]
**Branch/commit:** [branch name or SHA]

| Test case | Steps | Expected | Actual | Status |
|-----------|-------|----------|--------|--------|
| [Name] | [Steps taken] | [Expected result] | [What happened] | PASS/FAIL |
| ... | ... | ... | ... | ... |

**Screenshot evidence:** [attached]

---

### SEO Review

**URL tested:** https://viracue.ai/blog/new-article

**Technical SEO (Blocking checks):**
- [x] Meta title present and unique: "Real-Time Sales Coaching vs Post-Call Review | ViraCue"
- [x] Single H1 tag: "Real-Time Sales Coaching vs Post-Call Review"
- [x] Meta description present (142 chars): "Compare real-time coaching to post-call review. Analyze which approach closes more deals with data from 47 customer teams."
- [x] Image alt text: 8/8 images have descriptive alt text (100%)
- [x] Content length: 2,847 words (exceeds 600-word threshold for competitive keyword)
- [x] HTTP 200 status, no accidental noindex
- [x] Heading hierarchy: H1 → H2 → H3 (no skips)
- [x] Canonical tag: `<link rel="canonical" href="https://viracue.ai/blog/real-time-sales-coaching-vs-post-call-review">`

**On-page SEO (Warnings):**
- [ ] Missing OG image tag (`og:image` not set) — *WARN: Add og:image for social sharing*
- [x] Schema markup present: ArticleSchema.jsonld with author, datePublished, wordCount
- [x] Readability: grade 10 (acceptable; target ≤ 12)
- [x] Internal links: 5 found (links to pricing, product demo, 2 related blog posts, 1 methodology guide)
- [x] Core Web Vitals (mobile): LCP 2.1s, FID 45ms, CLS 0.08 (all GOOD)

**E-E-A-T & Authority Signals:**
- [x] Named author with byline: "Sarah Chen, VP Sales Enablement at ViraCue" + LinkedIn URL
- [x] Proprietary data disclosed: "Analysis of 47 customer teams across 6 months"
- [x] Customer metrics with context: "Morgan Patel (Northfield Tech): 19% lift in first 3 weeks"
- [x] Psychological depth: "Real-time coaching triggers cognitive overload; post-call review allows space for processing"
- [x] Competitive transparency: "Gong focuses on real-time alerts; we chose post-call because our data showed..."

**AI SEO Authenticity Score:** 8.7/10 — Publish as-is
- ✅ 5 green flags: named author, proprietary dataset, customer metrics, behavioral depth, competitive positioning
- ✅ 0 red flags
- **Verdict**: Strong E-E-A-T signals. Content demonstrates original research, not generic AI synthesis.

**Topical Authority Clustering:**
- [x] Part of "Sales Coaching" pillar cluster
- [x] Links back to pillar post: "The Complete Guide to Sales Coaching Automation"
- [x] Links to 2 sibling posts: "How to Practice Sales Calls Alone" + "Handling Objections Under Pressure"
- [x] All cluster posts have self-referential canonical tags (correct)
- **Equity flow**: Pillar receives inbound links from 4 cluster posts (healthy)

**SEO verdict:** PASS (no blocking issues; minor warning on OG image)

---

### AI SEO Deep Dive (Only if red flags detected)

**[Only include this section if AI authenticity score < 7.0]**

**Detected issues:**
- [ ] Generic positioning without proprietary stance
- [x] **(EXAMPLE)** Missing author byline — currently "Editorial Team"
  - **Fix required**: Add named author + LinkedIn URL before publish
  - **Rationale**: March 2024 Google core update explicitly downranks AI-generated content without human attribution. E-E-A-T signals require verifiable author identity.

- [ ] No proprietary data or customer validation
- [ ] Repetitive structure (problem→response→example) repeated without exception

**Recommendations:**
1. Identify content owner (Sales Leader, Product Manager, etc.)
2. Add author byline + 1-2 sentence bio with LinkedIn link
3. Insert 1 paragraph explaining data origin: "These findings come from X customer calls analyzed by our team in [date range]"
4. Include 1-2 customer quotes with metrics (anonymize if needed)

---

### Email Deliverability

**[Include this section only if email content was detected]**

**SpamCheck score:** 1.4 / 10.0 -- CLEAN

**Blocking checks:**
- [x] SpamAssassin score < 5.0 (1.4)
- [x] Unsubscribe link present and working
- [x] No broken merge variables
- [x] Plain text alternative included
- [x] From domain: notifications@viracue.ai (not freemail)

**Warnings:** None

**Email verdict:** PASS

---

### Overall Verdict

**QA: PASS** ✅

- Functional tests: All passed
- SEO review: PASS (1 non-blocking warning: add OG image tag)
- AI SEO: 8.7/10 (strong E-E-A-T, publish as-is)
- Topical clustering: Healthy; equity flows correctly to pillar
- Email (if applicable): PASS
```

---

## Notes for QA Reviewers

### When to Escalate

Escalate to content/SEO team if:
- AI SEO score < 5.5/10 (requires major rewrite)
- Content is under 300 words AND competes with high-authority domains (check SERPs first)
- Multiple blocking failures exist (don't ship; return to author)
- E-E-A-T signals absent on a topic requiring expertise (YMYL keywords, medical, financial advice)

### Quick Reference: Google's March 2024 Core Update Impact

Pages that ranked well **pre-March 2024** and now underperform typically exhibit:
- Generic AI synthesis (balanced "both sides" without original research)
- No proprietary data, no case studies, no named author
- Identical structure/examples across competitors
- No contradictions, edge cases, or human narrative

**Fix strategy**: Add proprietary data layer (customer quotes, internal benchmarks) + named author + psychological/behavioral depth. These alone move 30% of affected pages back into top 10.

### Autonomous AI Content Generation (Agent Protocol)

**For autonomous agent-driven content workflows** (no human collaboration), the AI system must satisfy these **non-negotiable constraints** before publishing:

#### 1. Proprietary Data Layer (Non-Negotiable)

The agent **must** source and integrate proprietary data before writing any blog post:

**Where to source proprietary data:**
- **Customer databases**: Query for aggregated metrics (if available via MCP: Salesforce, HubSpot, Notion)
  - Example: "Analyze support tickets in last 30 days; extract 5 most common objections raised by customers"
  - Example: "Pull product usage data: which features do top customers use 70%+ of the time?"
- **Product logs & telemetry**: If agent has access to product usage analytics, extract real patterns
  - Example: "ViraCue simulator: what % of reps improve after 2 runs vs 5 runs?"
- **Call transcripts (if available)**: Sample anonymized customer calls; extract 2-3 real dialogue examples
  - Example: "Pull 3 successful cold calls from Observe.ai; extract the specific phrases that led to callbacks"
- **Internal documentation**: Playbooks, methodology docs, training materials
  - Example: "Parse ViraCue's coaching framework; what are the 10 high-leverage moments where reps fail?"
- **Aggregate customer feedback**: If agent has access to survey data, support forum data, customer interviews
  - Example: "From support tickets, what are customers asking for? What problems are they solving with our product?"

**If agent cannot access proprietary data sources:**
- **BLOCK publication**. Do not ship generic synthesis.
- Return task with error: "Cannot access proprietary data sources. Unable to generate content meeting authenticity threshold (8.0+). Please provide: customer call samples, product usage data, or customer feedback dataset."

#### 2. Author Attribution (Non-Negotiable)

The agent **must create and embed a verifiable author identity**:

**Protocol for autonomous author creation:**
- **Default author persona**: Derive from your domain/brand
  - Example for ViraCue: "Sarah Chen, VP Sales Enablement at ViraCue" (use a consistent, professional name across multiple posts)
  - Example for Viraforge: "Marcus Rodriguez, AI Infrastructure Lead at Viraforge Labs"
- **Author bio template** (must be included in every post):
  ```
  [FirstName] [LastName] leads [role/domain] at [Company]. 
  Over [X years] in [industry/domain], [he/she/they] has worked with [X customers/companies], 
  focusing on [specific expertise area]. This guide draws from [data source: product research, 
  customer interviews, X case studies].
  ```
- **LinkedIn profile requirement**: 
  - If you control a LinkedIn for the domain (e.g., ViraCue's official account or a team member's account), link to it
  - If no LinkedIn exists, create a simple author page on the domain itself (e.g., viracue.ai/team/sarah-chen)
  - Author must have a profile that validates their expertise (past roles, credentials, or links to other published work)
- **Byline format in HTML**:
  ```html
  <div class="author">
    <p>By <strong><a href="https://linkedin.com/in/[profile]">[FirstName] [LastName]</a></strong>, 
    [Title] at [Company] | Published [Date]</p>
  </div>
  ```

#### 3. Data Origin Statement (Non-Negotiable)

Every blog post **must include a research methodology paragraph** that explains where the insights come from:

**Placement**: Immediately after the H1, before the first section.

**Template**:
```
This guide is based on [describe data source]:
- Analysis of [X] customer calls / [X] product data points / [X] case studies
- Conducted between [date range]
- Focused on [specific outcome or metric]
- Sample: [X] customers across [industries/company sizes]

Key findings: [1-2 sentence summary of the proprietary insight]
```

**Required data specificity** (agent must populate actual numbers):
- ❌ Bad: "We analyzed call data"
- ✅ Good: "We analyzed 847 cold calls from 47 customer teams over 6 months, identifying patterns in the first 10 seconds"

- ❌ Bad: "Customer feedback shows improvement"
- ✅ Good: "Among early adopters of ViraCue's post-call review feature, 76% of reps reported increased confidence in objection handling within 2 weeks"

#### 4. Proprietary Insight Requirement (Non-Negotiable)

The content **must include at least 2 proprietary insights** (findings that are unique to your product/data):

**Proprietary insight types:**

a) **Quantitative finding**: A metric derived from your product/customers
   - Example: "Reps who practice objection handling 3+ times weekly see 2.1x higher close rates than those who practice 1x weekly"
   - Source: Query ViraCue's simulator usage data + correlate with customer deal metrics

b) **Contradiction of industry consensus**: Your data shows something different from what generic blogs say
   - Example: "Industry guidance says to script cold calls. Our data shows the opposite: top-performing reps spend 60% less time on scripts and 40% more time on discovery questions."
   - Source: Call recording analysis + rep performance data

c) **Behavioral pattern unique to your product**: Something only discoverable through using/analyzing your solution
   - Example: "The 'pregnant pause' works—but only if the rep has already built trust. In cold calls, silence > 4 seconds triggers a 'hang up' response 73% of the time."
   - Source: ViraCue call simulator data + real call outcome analysis

d) **Calibrated benchmark**: "Normal" vs "good" vs "excellent" based on your customer cohort
   - Example: "For SDR teams, a 15% callback rate from voicemail is average. Top performers hit 28-32%. Here's how."
   - Source: Aggregate customer usage + outcome data

**Enforcement**: If content has zero proprietary insights, **BLOCK publication**. Return error:
```
"Content does not contain proprietary insights. Generic positioning detected.
Add minimum 2 of: quantitative finding, industry contradiction, behavioral pattern, or benchmark.
Use product data / customer data to support claims."
```

#### 5. Edge Cases & Nuance (Required)

The agent **must include at least 1 edge case or exception** that shows intellectual depth:

**Templates**:
- "This approach works EXCEPT when..."
- "The exception: if X variable is true, then..."
- "Early reps struggle here because... experienced reps know to..."
- "What works on inbound doesn't work on cold outbound because..."

**Examples**:
- ✅ "Silence works in discovery. But in objection handling, > 4 seconds of silence on a cold call triggers hang-up behavior 73% of the time."
- ✅ "Post-call review is better for behavioral change. But if reps never watch their own recordings, real-time coaching wins on adoption."
- ❌ "Both approaches have pros and cons." (Generic; no edge case)

**Enforcement**: If content reads as universally applicable with zero exceptions, request revision:
```
"Content lacks nuance. Every scenario in the world has an exception.
Add 1 paragraph: 'The exception: [when this advice breaks down] because [reason].'
Source from product data or customer feedback where this exception appears."
```

#### 6. Competitive Positioning (Required)

The agent **must reference competitors or alternatives transparently**:

**Template**:
```
[Competitor] is excellent for [use case]. We chose a different approach because [specific reason backed by data]:
- [Gong focuses on X; our research shows Y is more impactful for post-call coaching]
- [Salesloft's strength is in forecasting; we optimized for rep skill development]
```

**Enforcement**: If no competitors mentioned, agent should research and add 1 paragraph:
```
"Research competitive landscape. Reference 1-2 alternatives/competitors.
Explain why your approach differs, backed by data (cost, adoption rate, time-to-value, etc.)
Do not trash-talk; be transparent about trade-offs."
```

#### 7. Customer Validation (Required for New Pages)

The agent **must include at least 2 customer examples** with:
- Real name (or anonymized role + company)
- Specific metric or outcome (not generic praise)
- Context on how they used the advice

**Template**:
```
Morgan Patel, SDR Manager at Northfield Tech, tested Scenario 3 (early objection handling) 
with her 6-person team. Within 3 weeks, they improved from 8% to 9.5% callback rates—a 19% lift.
"The biggest shift was consistency," Morgan says. "New hires and tenured reps started using 
the same discovery language, which reduced dropped calls by 23%."
```

**Enforcement**: If fewer than 2 customer examples with metrics, flag:
```
"Content requires minimum 2 customer examples with specific metrics.
Query customer database / interview customers for outcomes.
Template: [Name/Role] at [Company] achieved [metric] using [your advice]."
```

---

### Autonomous Agent Workflow (End-to-End)

When an agent is tasked with publishing a blog post autonomously:

1. **Data sourcing phase** (Required; must complete before writing)
   - Query all available proprietary data sources (product usage, call transcripts, customer data, support tickets)
   - Extract 5-10 key metrics / patterns / insights
   - If insufficient data, BLOCK and return error asking for data access

2. **Outline generation** (Must include proprietary insights + edge cases)
   - Create structure that weaves proprietary data throughout, not as an afterthought
   - Allocate 20-30% of content to "here's what our data shows" vs. "here's generic advice"

3. **Author profile creation** (Must be completed before publishing)
   - Define author name, title, bio
   - Create or link to LinkedIn profile (if domain-controlled; otherwise create author page)
   - Embed author bio in HTML; include publication date and byline

4. **Writing phase** (Must satisfy all constraints)
   - Draft with author voice (first-person "we", not passive "one could say")
   - Integrate proprietary data early and often (not clustered at the end)
   - Include 2+ proprietary insights
   - Include 1+ edge case
   - Include 1+ competitive positioning paragraph
   - Include 2+ customer examples with metrics

5. **Research methodology insertion** (Required; non-negotiable)
   - Add methodology paragraph immediately after H1
   - Populate with actual numbers and data sources

6. **QA validation** (Before publishing)
   - Run SEO checks: all blocking failures must pass
   - Run AI SEO audit: score must be ≥ 7.0
     - If score < 7.0, identify missing constraint (proprietary data, edge cases, author, etc.)
     - Revise until score ≥ 7.0
   - Verify author attribution is clear and linked

7. **Publish**
   - Add schema markup (ArticleSchema.jsonld with author, datePublished)
   - Add OG tags for social sharing
   - Build internal links: add 1 link back to pillar post (if in cluster) + 2-3 links to sibling posts
   - Set canonical tag

---

### Hard Blocks: Autonomous Content Cannot Ship If

- [ ] No proprietary data layer (generic synthesis only) → **BLOCK**
- [ ] No named author with verifiable profile → **BLOCK**
- [ ] No research methodology statement → **BLOCK**
- [ ] Zero proprietary insights (generic advice only) → **BLOCK**
- [ ] No edge cases or exceptions mentioned → **BLOCK**
- [ ] No customer validation (< 2 examples with metrics) → **BLOCK**
- [ ] AI SEO authenticity score < 7.0 → **BLOCK** (revise until ≥ 7.0)
- [ ] Missing meta title, H1, description, canonical → **BLOCK**

**If ANY block is triggered, return the post for revision with specific error message identifying which constraints were not met.**

