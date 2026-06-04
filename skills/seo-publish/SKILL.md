---
name: seo-publish
description: Generate SEO-optimized blog posts for ironnoodle.com, deploy via git push to Cloudflare Pages, ping IndexNow for fast crawl, and update blog index + resources page. Used by the SEO Analyst agent to autonomously publish content from keyword research.
---

# SEO Publish — Keyword to Live Article

Autonomously write, deploy, and index a blog post on ironnoodle.com from a target keyword.

## Inputs

| Field | Required | Description |
|-------|----------|-------------|
| `keyword` | YES | Primary target keyword (e.g. "AI receptionist law firm") |
| `secondary_keywords` | no | 2-5 related keywords to weave in |
| `case_study` | no | Case study text, transcript, or bullet points to embed |
| `product` | no | Which IRT product this maps to (NB OS, AI Voice, GetDocs, etc.) |
| `word_count` | no | Target word count (default: 1800-2200) |
| `approval_required` | no | If true, pause after draft for CMO review before deploying (default: false) |

## Ground Rules

1. **Read `/Users/robertstanley/ironnoodle-site/CLAUDE.md` EVERY run.** It has URL rules, asset rules, and the blog post checklist. Violating these breaks SEO.
2. **Never expose vendor names** in published content: Synthflow, ElevenLabs, OpenRouter, Claude, Anthropic, OpenAI, GHL, Docker, Tailscale, Zapier, Skillboss.
3. **Never fabricate** testimonials, case outcomes, statistics, attorney endorsements, or compliance badges.
4. **No `.html` in any internal href, canonical, OG URL, or structured data URL.** Cloudflare strips extensions — `.html` links create 308 redirects that hurt rankings.
5. **All paths absolute.** `href="/blog/slug"` not `href="blog/slug"`.
6. **Match existing blog template exactly** — use an existing post as the structural reference.
7. **Slug must target the keyword.** `/blog/ai-receptionist-law-firm` not `/blog/new-article-may-2026`.

## Workflow

### 1. Research & Outline

1. Confirm the keyword isn't already covered — check existing posts in `/Users/robertstanley/ironnoodle-site/blog/`.
2. If a similar post exists, decide: update existing vs. new complementary post.
3. Build outline:
   - H1: keyword-optimized title
   - 4-6 H2 sections covering search intent
   - FAQ section (3-5 questions from "People Also Ask" style queries)
   - Internal links to relevant product/blog pages on ironnoodle.com
   - External links to authoritative sources (studies, bar association pages, etc.)

### 2. Write the Article

Content must:
- Lead with the keyword in the title and first paragraph
- Include the `case_study` content naturally (not pasted verbatim — synthesize it)
- Use IRT brand voice: direct, blunt, no-fluff, data-driven
- Include at least one comparison table
- Include internal CTAs (demo link, contact, product page)
- End with FAQ section using FAQPage structured data
- Target word count: 1800-2200 words

### 3. Build the HTML

Use the template structure from an existing blog post. Required elements:

```
<head>
  - GA4 gtag.js (G-ZHCKX8GM25) — FIRST in <head>
  - <meta charset>, viewport
  - <title> — keyword + " | Iron Noodle"
  - <meta name="description"> — 150-160 chars, keyword in first 60
  - <link rel="canonical" href="https://ironnoodle.com/blog/{slug}"> — NO .html
  - OG tags (og:type=article, og:title, og:description, og:url) — NO .html in URLs
  - Twitter Card tags
  - Article structured data (JSON-LD) — NO .html in URLs
  - FAQPage structured data (JSON-LD)
  - Google Fonts (Oswald + Inter)
  - <link rel="stylesheet" href="/style.css?v=5">
  - CogentCRM tracking script (tk_aebc37e3f03246be8657fd68115978cc)
  - Cloudflare Turnstile
</head>
<body>
  - Nav (match existing pattern)
  - Blog hero section (blue bg, white text)
  - Article body (max-width 780px, clean typography)
  - FAQ section
  - CTA section
  - Footer (match existing pattern)
  - lead-capture.js
</body>
```

### 4. Update Blog Index & Resources

1. **`/blog/index.html`** — Add card at TOP of grid (newest first). Update CollectionPage structured data positions.
2. **`/resources.html`** — Add card at TOP of grid (newest first, reverse chronological).

### 5. Deploy

```bash
cd /Users/robertstanley/ironnoodle-site
git add blog/{slug}.html blog/index.html resources.html
git commit -m "Add blog: {keyword-slug} — targets '{keyword}'"
git push origin main
```

Cloudflare Pages auto-deploys on push to `main`. Page is live within 60 seconds.

### 6. Index

**IndexNow** (Cloudflare supports this natively, but we also ping directly):

```bash
curl -s -X POST "https://api.indexnow.org/IndexNow" \
  -H "Content-Type: application/json" \
  -d '{
    "host": "ironnoodle.com",
    "key": "'"$(cat /Users/robertstanley/ironnoodle-site/indexnow-key.txt 2>/dev/null || echo 'NEEDS_SETUP')"'",
    "urlList": ["https://ironnoodle.com/blog/{slug}"]
  }'
```

If `indexnow-key.txt` doesn't exist yet, create it:
1. Generate a random key: `openssl rand -hex 16`
2. Save to `/Users/robertstanley/ironnoodle-site/indexnow-key.txt`
3. Create verification file: `/Users/robertstanley/ironnoodle-site/{key}.txt` containing the key
4. Commit and push both files
5. Then retry the IndexNow ping

**Google Search Console URL Inspection** (request indexing):

```bash
REFRESH=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/secrets/gdrive-tokens.json'))['refresh_token'])")
CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:?set GOOGLE_OAUTH_CLIENT_ID}"
CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT_SECRET:?set GOOGLE_OAUTH_CLIENT_SECRET}"
ACCESS_TOKEN=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&refresh_token=$REFRESH&grant_type=refresh_token" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inspectionUrl":"https://ironnoodle.com/blog/{slug}","siteUrl":"sc-domain:ironnoodle.com"}'
```

### 7. Report to Paperclip

Post an issue comment with:

```
## Published: {title}

- **URL:** https://ironnoodle.com/blog/{slug}
- **Keyword:** {keyword}
- **Secondary:** {secondary_keywords}
- **Word count:** {actual_count}
- **Product:** {product}
- **Deployed:** {timestamp}
- **IndexNow:** {success/failed}
- **GSC Inspection:** {indexed/discovered/not_yet}

### Internal links added
- [link text](url) — in section X

### Next steps
- Monitor GSC for impressions in 48-72 hours
- Check position for "{keyword}" in 7 days via Serper
```

## Validation Checklist (run before commit)

```bash
cd /Users/robertstanley/ironnoodle-site

# No .html in internal links
grep -n 'href=".*ironnoodle\.com.*\.html' blog/{slug}.html && echo "FAIL: .html in links" || echo "PASS"

# Canonical is clean
grep -n 'rel="canonical"' blog/{slug}.html | grep -v '\.html"' || echo "FAIL: .html in canonical"

# GA4 present
grep -q 'G-ZHCKX8GM25' blog/{slug}.html && echo "PASS: GA4" || echo "FAIL: GA4 missing"

# CogentCRM tracking present
grep -q 'tk_aebc37e3f03246be8657fd68115978cc' blog/{slug}.html && echo "PASS: CRM tracking" || echo "FAIL: CRM tracking missing"

# Style.css version matches current (v=5)
grep -q 'style.css?v=5' blog/{slug}.html && echo "PASS: CSS version" || echo "FAIL: CSS version mismatch"

# Structured data present
grep -q 'application/ld+json' blog/{slug}.html && echo "PASS: structured data" || echo "FAIL: no structured data"

# No vendor names leaked
grep -inE '(synthflow|elevenlabs|openrouter|gohighlevel|anthropic|openai|docker|tailscale|zapier|skillboss)' blog/{slug}.html && echo "FAIL: vendor name leaked" || echo "PASS: no vendor leaks"
```

All checks must PASS before pushing.

## Error Handling

| Error | Action |
|-------|--------|
| Keyword already covered by existing post | Report to CMO — suggest update vs. new post |
| IndexNow key not set up | Create key file, commit, then retry |
| Git push fails (auth) | Report — likely needs `gh auth login` on Mini |
| GSC token expired | Refresh using the OAuth flow above |
| Validation check fails | Fix the issue, do NOT push broken HTML |

## Scheduling

This skill can be triggered:
- **On demand:** CMO or CEO assigns a keyword task
- **From weekly content gap analysis:** SEO Analyst identifies opportunity keyword → auto-generates if `approval_required: false`
- **Batch mode:** Accept array of keywords, process sequentially, one commit per article
