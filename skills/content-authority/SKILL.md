---
name: content-authority
description: Defines ViraCue's content publication standards for proprietary data integration, author credibility, and AI content authenticity. Use before writing any blog post, landing page, or marketing content. Establishes the author persona, data sourcing process, and quality floor that all content must meet before handoff to QA.
---

# Content Authority Standards

Every piece of content published on viracue.ai must demonstrate genuine expertise — not generic AI synthesis. This skill defines what "publication-ready" means.

## Author Persona (Use Consistently)

All blog posts and long-form content use a consistent named author:

**Primary author:**
- **Name:** Damon DeCrescenzo
- **Title:** Founder & CEO, ViraCue
- **LinkedIn:** https://linkedin.com/in/damondecrescenzo
- **Bio (short):** Damon DeCrescenzo is the founder of ViraCue, an AI-powered sales coaching platform. He built ViraCue after seeing firsthand how traditional sales training fails to develop muscle memory in reps — the same reps who need to perform under pressure on live calls.
- **Bio (long):** Damon DeCrescenzo founded ViraCue to solve a problem he saw across every sales team he worked with: reps who could pass training but froze on real calls. ViraCue's AI simulation platform lets reps practice high-pressure scenarios — cold calls, objection handling, discovery calls — with realistic AI buyers before facing real prospects. The platform has been used by sales teams ranging from 3-person startups to enterprise SDR organizations.

**When to use a different author:**
- Guest posts or contributed content: use the guest's real name + credentials
- Technical deep-dives: can use "ViraCue Engineering Team" only if the content is genuinely technical (API docs, architecture posts)
- Never use "ViraCue Editorial Team" or "ViraCue Content Team" — these signal AI content mills

**Author HTML template:**
```html
<div class="author-byline">
  <p>By <strong><a href="https://linkedin.com/in/damondecrescenzo">Damon DeCrescenzo</a></strong>,
  Founder & CEO at ViraCue | Published [Date]</p>
</div>
```

**Author JSON-LD (required in every blog post):**
```json
{
  "@type": "Person",
  "name": "Damon DeCrescenzo",
  "jobTitle": "Founder & CEO",
  "url": "https://linkedin.com/in/damondecrescenzo",
  "worksFor": {
    "@type": "Organization",
    "name": "ViraCue",
    "url": "https://viracue.ai"
  }
}
```

## Proprietary Data Sourcing

Before writing any content, you MUST gather proprietary data. Generic advice without ViraCue-specific data does not ship.

### Data sources available to ViraCue content:

1. **Product usage patterns** — How reps use the simulator. What scenarios they practice most. Where they improve fastest. Typical session lengths. Repeat practice rates.

2. **Customer outcomes** — Metrics from customer teams: callback rates, close rate improvements, ramp time reduction, confidence scores. Use real numbers, anonymize company names if needed.

3. **Call analysis patterns** — What the AI detects in practice sessions: common freeze points, objection handling failures, discovery question gaps, silence patterns.

4. **Competitive differentiation** — What ViraCue does differently from Gong, Chorus, Salesloft, Observe.ai. Why the approach is different (practice-first vs analytics-first).

5. **Customer quotes** — Real feedback from users. Must include: name (or anonymized role), company (or anonymized size/industry), specific metric or outcome.

### Minimum data requirements per content type:

| Content type | Min proprietary data points | Min customer examples |
|---|---|---|
| Blog post (pillar, 2000+ words) | 5 | 3 |
| Blog post (cluster, 800-1500 words) | 3 | 2 |
| Landing page | 3 | 2 |
| Comparison page (vs competitor) | 4 | 2 |
| Case study | 8 | 1 (deep) |

### If you cannot source proprietary data:

**Do not write the content.** Post a blocker comment on the task:
```
BLOCKED: Cannot source proprietary data for this topic.
Need access to: [specific data source]
Alternative: [suggest a topic where data IS available]
```

## Research Methodology Paragraph

Every blog post MUST include a research methodology paragraph immediately after the H1, before the first section.

**Template:**
```
This guide is based on [data source]:
- Analysis of [X] customer calls / practice sessions / data points
- Conducted between [date range]
- Sample: [X] teams across [industries/sizes]
- Key finding: [1-2 sentence summary of the proprietary insight]
```

**Examples:**
- "This guide draws from 847 practice sessions across 47 customer teams over 6 months. We identified the 10 moments where reps freeze most often — and the specific techniques that break the freeze."
- "We analyzed cold call outcomes from 23 SDR teams using ViraCue's simulator. Teams that practiced these 7 objection responses saw 19% higher callback rates within 3 weeks."

## Content Brief (Complete Before Writing)

Before writing any content, complete this brief:

```markdown
## Content Brief

**Target keyword:** [primary keyword]
**Search intent:** [informational / commercial / transactional]
**Competitor URLs (top 3 ranking):**
1. [URL] — [what they cover, word count, angle]
2. [URL] — [what they cover, word count, angle]
3. [URL] — [what they cover, word count, angle]

**Our unique angle:** [what we say that they don't — must be backed by proprietary data]
**Proprietary data points to include:**
1. [metric/finding from ViraCue data]
2. [metric/finding from ViraCue data]
3. [metric/finding from ViraCue data]

**Customer examples to include:**
1. [name/role at company — metric/outcome]
2. [name/role at company — metric/outcome]

**Pillar/cluster placement:**
- Pillar post: [URL of the pillar post this links to]
- Sibling posts to link: [URL 1], [URL 2]

**Target word count:** [based on competitor analysis]
**Author:** Damon DeCrescenzo, Founder & CEO
```

Post this brief as a comment on the issue BEFORE starting to write. If the brief cannot be completed (missing data, unclear angle), post a blocker.

## Pillar/Cluster Content Architecture

ViraCue's blog uses a pillar/cluster model. Every post must fit into a cluster.

### Current clusters:

**Cluster 1: Sales Call Practice**
- Pillar: "The Complete Guide to Sales Call Practice" (to be created)
- Cluster posts: cold call practice, objection handling, voicemail scripts, gatekeeper tactics, discovery questions

**Cluster 2: Sales Coaching Technology**
- Pillar: "AI Sales Coaching: The Complete Guide" (to be created)
- Cluster posts: real-time vs post-call, AI coaching ROI, coaching for small teams, sales roleplay software

**Cluster 3: Sales Training ROI**
- Pillar: "Measuring Sales Training ROI" (to be created)
- Cluster posts: ramp time reduction, rep confidence metrics, practice frequency vs performance

### Linking rules:
- Every cluster post links back to its pillar (1 link minimum)
- Every cluster post links to 2-3 sibling posts in the same cluster
- Pillar posts link to ALL cluster posts in the cluster
- Do NOT cross-link between clusters excessively (1 link max)

### When creating a new post:
1. Identify which cluster it belongs to
2. If no cluster exists, propose one in the content brief
3. Add the post to the cluster map (update this skill or a separate cluster doc)

## Edge Cases and Nuance (Required)

Every piece of content MUST include at least one section that shows intellectual depth:

**Templates:**
- "This works — except when [specific scenario]. Here's why: [explanation]"
- "Most guides recommend X. Our data shows the opposite for [specific context]."
- "The counterintuitive finding: [thing that contradicts common advice], backed by [data]."

**Why this matters:** Google's March 2024 core update specifically downranks content that reads as balanced consensus without original perspective. A blog post that says "both approaches have merits" without taking a stance is generic AI synthesis. A post that says "real-time coaching fails for 73% of new hires because of cognitive load — here's our data" is authoritative.

## Competitive Positioning (Required)

Every piece of content must reference at least one competitor or alternative transparently:

**Good:** "Gong excels at call analytics and revenue intelligence. ViraCue takes a different approach: practice before the call, not analysis after. Our data shows reps who practice 3x weekly close 19% more deals than reps who only review past calls."

**Bad:** "ViraCue is the best sales coaching platform." (No comparison, no data, no transparency)

**Bad:** No mention of alternatives at all. (Looks like the author doesn't know the market)

## Pre-Handoff Checklist

Before moving any content to `in_review`, verify ALL of these:

- [ ] Content brief completed and posted as issue comment
- [ ] Named author (Damon DeCrescenzo) with LinkedIn link in byline
- [ ] Research methodology paragraph after H1
- [ ] Minimum proprietary data points met (see table above)
- [ ] Minimum customer examples met (see table above)
- [ ] At least 1 edge case / nuance / contrarian finding
- [ ] At least 1 competitive positioning paragraph
- [ ] BlogPosting JSON-LD schema with author, datePublished, wordCount
- [ ] Internal links: 1 to pillar + 2-3 to siblings
- [ ] `/seo page` score with zero blockers
- [ ] `/seo content` score with zero blockers
- [ ] AI SEO authenticity score >= 7.0 (per qa-domain-review standards)
