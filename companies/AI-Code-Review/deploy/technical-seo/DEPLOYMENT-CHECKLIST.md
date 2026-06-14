# DJ Technologies — Technical SEO Deployment Checklist

## Prerequisites (must have before starting)

- [ ] SSH key with root/sudo access to all 3 servers
- [ ] Google Search Console — domain ownership verified for all 3 domains
- [ ] Google Analytics 4 — property created with 3 data streams
- [ ] Cloudflare API token (if using CF for deployments)
- [ ] Lovable project access (for .in and .uk SPA head injection)

## Phase 1: robots.txt + Sitemaps

### djtechnologies.in
- [ ] Upload `07-robots-djtechnologies.in.txt` as `robots.txt`
- [ ] Upload `05-sitemap-djtechnologies.in.xml` as `sitemap.xml`

### djtechnologies.uk
- [ ] Upload `08-robots-djtechnologies.uk.txt` as `robots.txt`
- [ ] Upload `06-sitemap-djtechnologies.uk.xml` as `sitemap.xml`

### djtechnologies.net
- [ ] Append AI crawler rules from `07-robots-djtechnologies.in.txt` to existing `robots.txt`

## Phase 2: JSON-LD Schema Injection

### djtechnologies.in + .uk (Lovable/React SPA)
**Option A (preferred): Server-side injection** — edit Lovable project's `index.html` template:
- [ ] Add Organization + LocalBusiness schema block
- [ ] Add FAQPage schema block
- [ ] Add Product/Service schema block
- [ ] Add BreadcrumbList + WebSite schema block
- [ ] Add Comparison Table schema block
- [ ] Add meta tags (description, OG, Twitter, canonical)
- [ ] Add GA4 gtag code

**Option B (fallback): Client-side injection** — inject via JS in SPA entry point
- [ ] Add `injectSchema.js` to `main.tsx` with all 5 schema blocks

### djtechnologies.net (WHMCS)
- [ ] Add schema blocks to WHMCS header template (System Settings → Other → Head Output)
- [ ] Or edit `templates/hostx-child/header.tpl`

## Phase 3: GA4

- [ ] Follow `10-ga4-implementation-guide.md` for all 3 domains
- [ ] Enable cross-domain tracking between .in, .uk, .net
- [ ] Verify GA4 Realtime shows active session

## Phase 4: Search Console Submission

- [ ] Add djtechnologies.in as property
- [ ] Add djtechnologies.uk as property
- [ ] Add djtechnologies.net as property
- [ ] Submit sitemaps to Google Search Console
- [ ] Submit to Bing Webmaster Tools
- [ ] Request manual indexing for homepage

## Verification

- [ ] `curl https://djtechnologies.in/robots.txt` → valid
- [ ] `curl https://djtechnologies.in/sitemap.xml` → valid XML
- [ ] `curl -s https://djtechnologies.in | grep "application/ld+json"` → 5+ schema blocks
- [ ] `curl -s https://djtechnologies.in | grep "gtag"` → GA4 code present
- [ ] Google Rich Results Test → passes
- [ ] Mobile-Friendly Test → passes

## Artifact Reference

| # | Artifact | File | Applies To |
|---|---|---|---|
| 1 | Organization + LocalBusiness schema | `01-organization-localbusiness-schema.jsonld` | .in, .uk |
| 2 | FAQPage schema | `02-faq-schema.jsonld` | .in, .uk |
| 3 | Product + Service schema | `03-service-schema.jsonld` | .in, .uk |
| 4 | BreadcrumbList + WebSite + Article schema | `04-article-breadcrumb-schema.jsonld` | .in, .uk |
| 5 | Sitemap (.in) | `05-sitemap-djtechnologies.in.xml` | .in |
| 6 | Sitemap (.uk) | `06-sitemap-djtechnologies.uk.xml` | .uk |
| 7 | robots.txt (.in) | `07-robots-djtechnologies.in.txt` | .in |
| 8 | robots.txt (.uk) | `08-robots-djtechnologies.uk.txt` | .uk |
| 9 | Technical audit report | `09-audit-report.md` | All 3 |
| 10 | GA4 setup guide | `10-ga4-implementation-guide.md` | All 3 |
| 11 | Implementation guide | `11-implementation-guide.md` | All 3 |
| 12 | Comparison table schema | `12-comparison-table-schema.jsonld` | .in, .uk |
| 13 | Deployment script | `deploy-seo.sh` | All 3 |
| 14 | Deployment checklist | `DEPLOYMENT-CHECKLIST.md` | All 3 |

## Server Infrastructure

| Domain | IP Address | Platform | Access Method |
|---|---|---|---|
| djtechnologies.in | 185.158.133.1 | Lovable SPA (l5e.io) | Lovable project / Cloudflare |
| djtechnologies.uk | 185.158.133.1 | Lovable SPA (l5e.io) | Lovable project / Cloudflare |
| djtechnologies.net | 103.241.168.254 | WHMCS | SSH to 103.241.168.254 |
| paperclip.djtechnologies.net | 103.241.168.252 | Paperclip API | Current environment |
