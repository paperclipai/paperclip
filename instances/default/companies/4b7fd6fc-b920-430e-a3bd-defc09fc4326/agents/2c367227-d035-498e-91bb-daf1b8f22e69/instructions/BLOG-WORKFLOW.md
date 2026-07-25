# Blog Post Workflow Template

**⚠️ READ-FIRST:** Before drafting or publishing anything, you (CMO) and the CTO MUST have read `../shared/GENESIS-WEBSITE-GUARDRAILS.md` end-to-end. That file is the canonical source of truth. The rules below are operational; if anything below contradicts the shared file, the shared file wins.

Use this template when creating a new blog post parent issue. Create child issues for each gated step.

## Content Brief (Pre-Writing Gate — GEN-620)

Before any blog post is written, the CMO must produce a brief. The brief is created as a document on the parent issue.

### Brief Template
- Target Keyword + search volume
- Search Intent (informational/commercial/navigational)
- Competitor Gap (what top 3 results miss)
- Outline (H2 sections)
- Internal Link Targets with anchor text
- Featured Image Concept
- Meta Description Draft (<=155 chars)
- Success Metric

### Pipeline Flow
CEO assigns topic → CMO produces brief → Benjamin approves brief → CMO/Writer drafts → Editor reviews → CTO deploys → Red team verifies → Done

## Workflow

| Day | Step | Owner | Issue Template |
|-----|------|-------|---------------|
| Monday AM | CEO assigns topic, CMO researches keywords | CEO → CMO | Draft in parent issue description |
| Monday PM | CMO produces content brief + outline | CMO | [Content Brief document](#content-brief-pre-writing-gate) |
| Tuesday | Benjamin approves brief (hard gate) | Benjamin (human) | Approval via issue-thread interaction |
| Wednesday | Write full draft (1200-1800 words) from approved brief | CMO | Draft in parent `blog-post` document |
| Thursday | CEO quality gate (brand voice, accuracy, SEO) | CEO | [CEO Quality Gate subtask](#ceo-quality-gate-subtask) |
| Friday | CTO publishes to WordPress with schema + internal links | CTO | [CTO Publish subtask](#cto-publish-subtask) |
| **Friday PM** | **Post-publish rendering QA — smoke check the live page** | **CMO** | **[Post-Publish QA subtask](#post-publish-qa-subtask)** |

## Parent Issue Description Template

```markdown
## Goal
Write and publish an SEO-optimised blog post: "{title}"

## Target Keywords
"{primary keyword}"

## Internal Links
Link to: {service page}

## Content Pillar
{pillar}

## SEO Checklist
1. Target keyword in title (near front)
2. Target keyword in URL slug
3. Meta description with keyword + CTA (150-160 chars)
4. H1 = title, H2s structure the content
5. Internal links to 2-3 service pages
6. Internal links to 1-2 other blog posts
7. At least 1 image with alt text
8. FAQ section (3-5 questions) for FAQ schema
9. Author byline (Benjamin Ang for EEAT)
10. Category + tags in WordPress

## Content Brief (Required — GEN-620)
Provide a content brief as an issue document (`brief`) before drafting. Include:
- Target Keyword + search volume
- Search Intent (informational/commercial/navigational)
- Competitor Gap (what top 3 results miss)
- Outline (H2 sections)
- Internal Link Targets with anchor text
- Featured Image Concept
- Meta Description Draft (<=155 chars)
- Success Metric

## Workflow
- Monday AM: CEO assigns topic, CMO researches keywords
- Monday PM: CMO produces content brief + outline
- Tuesday: Benjamin approves brief (hard gate)
- Wednesday: CMO writes full draft (1200-1800 words) from approved brief
- Thursday: CEO quality gate (brand voice, accuracy, SEO)
- Friday: CTO publishes to WordPress with schema + internal links
- Friday PM: CMO post-publish rendering QA (smoke check live page)

## Acceptance
- Post is live on genesismotiondesign.com/blog/
- FAQ schema validates in Google Rich Results Test
- Internal links added to 2 existing posts
- GSC indexing requested
- Post-publish rendering QA passed (no raw shortcodes, clean render)
```

## CEO Quality Gate Subtask

```markdown
## Task
Review the blog post draft for brand voice consistency, factual accuracy, and SEO alignment.

## Context
Draft is attached as document: [parent-issue]#document-blog-post

## Acceptance
- Brand voice is consistent with Genesis Motion Design tone
- All claims are factually accurate
- SEO checklist items are satisfied
- Approved or returned with revision notes
```

## Benjamin Approval Subtask

```markdown
## Task
Benjamin Ang reviews and approves the blog post draft.

## Context
Draft is attached as document: [parent-issue]#document-blog-post

## Acceptance
- Benjamin has reviewed and approved the content
- Any revision requests are addressed before CTO publish
```

## CTO Publish Subtask

```markdown
## Task
Publish the blog post to genesismotiondesign.com with schema markup and internal links.

## Context
Draft is attached as document: [parent-issue]#document-blog-post

## Steps
1. **Pre-publish Wall check (MANDATORY — paste output in your task comment):**
   ```bash
   ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
     "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ eval-file /tmp/genesis-content-healthcheck.sh"
   ```
   All 4 sections must be OK. If any FAIL, STOP and run the fix scripts (Section 2.3 of `../shared/GENESIS-WEBSITE-GUARDRAILS.md`) before continuing.
2. **Pre-write DB scan (MANDATORY — must return 0):**
   ```bash
   ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
     "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ db query \"SELECT COUNT(*) FROM wp_posts WHERE post_content LIKE '%rnrn%' OR post_content LIKE '%>rn%' OR post_content LIKE '%xa0%' OR post_content LIKE '%rn<%'\""
   ```
3. Add hero/featured image with alt text
4. Add at least one inline image with alt text
5. Publish to WordPress with correct category and tags
6. Implement FAQ schema markup (validate with Google Rich Results Test)
7. Add internal links from 2 existing blog posts back to this new post
8. Submit URL to Google Search Console for indexing

## CRITICAL: Shortcode Integrity
- Use ONLY straight ASCII quotes in WPBakery/VC shortcode attributes
- Verify no smart/curly quotes in shortcodes before publishing
- After publishing, do a quick curl check of the page for raw `[/vc_` strings

## CRITICAL: LLM keyword text box (gen977) — JULY 25 REGRESSION
If the page contains a `[gen977-*]` shortcode (LLM keyword text box):

1. **Verify the keyword text inside the `<strong>` tag is non-empty.** Empty keyword = broken box. Do NOT ship a broken box.
2. If the box is broken and you cannot fix it in this run, REMOVE the gen977 shortcode from the page entirely. Shipping an empty/broken keyword box is the regression the user has now flagged twice.
3. After publish: `curl -s https://genesismotiondesign.com/<page-path>/ | grep -i "empty keyword\|broken-llm\|gen977-broken"` — must return zero matches.
4. Open the live page in the CDP browser. The box must be either (a) hidden by `genesis-hide-broken-llm-boxes.php`, or (b) visible with a real keyword + a working button. Never an empty box visible to visitors.

## CRITICAL: Wall self-check after publish
After publish + cache purge, re-run `/tmp/genesis-content-healthcheck.sh`. If any layer is degraded, STOP and fix before declaring done. See `../shared/GENESIS-WEBSITE-GUARDRAILS.md` Sections 8 + 9 for cache purge order and post-publish QA.
```

## Post-Publish QA Subtask (NEW — added per GEN-231; reinforced per JULY 25 LLM-box regression)

```markdown
## Task
Perform a rendering smoke check on the published blog post. Verify the live page renders correctly with no raw shortcodes, encoding artifacts, broken LLM boxes, or broken elements.

## Prerequisites
- CTO publish step is complete
- Blog post URL is known

## QA Checklist
1. **No raw shortcodes.** Fetch the live page and search for raw VC shortcode artifacts:
   - Check for `[/vc_column_text]`, `[/vc_column]`, `[/vc_row]`, `[/vc_` anywhere in page source
   - Check for unrendered `[vc_row`, `[vc_column` opening tags
2. **No smart-quote encoding in shortcodes.** Check that VC shortcode attributes use straight ASCII quotes (")
   - Look for curly/smart quotes (`\u201c`, `\u201d`) inside shortcode brackets
3. **FAQ schema present.** Validate the page has FAQ JSON-LD schema block
4. **Images render.** Verify hero/featured image and inline images load (no broken image links)
5. **Internal links resolve.** Spot-check 2-3 internal links point to valid Genesis pages
6. **SEO metadata present.** Verify title tag, meta description exist
7. **No visible encoding artifacts.** Scan the rendered text for `&amp;`, `&quot;`, or other HTML entity leakage
8. **No rn/xa0/n artifacts.** `curl -s https://genesismotiondesign.com/<page>/ | grep -c "rnrn\|>rn\|<rn\|]rn\|)rn\|,rn\|!rn\|?rn\|xa0"` must be 0.
9. **LLM keyword box (gen977) renders correctly.** If the page has a `[gen977-*]` shortcode:
   - `curl -s <page> | grep -i "empty keyword\|broken-llm\|gen977-broken"` must return zero matches
   - Open the page in the CDP browser. The box must be either (a) hidden by the mu-plugin because broken, or (b) visible with a non-empty `<strong>` keyword and a working submit button.
   - **If the box is visible with empty/broken content → BLOCK the parent issue and file a corrective issue assigned to CTO.** This is the JULY 25 regression class.
10. **Wall health still OK.** Re-run `/tmp/genesis-content-healthcheck.sh`. All 4 sections must be OK.

## Pass Criteria
All 10 checklist items pass. If any fail, create a corrective issue assigned to CTO and block the parent on it.

## Demonstration (GEN-221)
On the [Motion Graphics vs Animation](https://genesismotiondesign.com/motion-graphics-vs-animation/) page:
- Zero raw VC shortcodes present
- FAQ schema present and valid
- Images and internal links render correctly
- SEO metadata clean
- LLM keyword box (gen977) either hidden by mu-plugin OR shows real keyword text — never empty/broken
```
