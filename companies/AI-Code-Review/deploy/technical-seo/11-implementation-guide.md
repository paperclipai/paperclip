# Implementation Guide — DJ Technologies Technical SEO

## Overview

Deploy all technical SEO artifacts across 3 domains. This guide is for the system administrator / developer with access to deploy code and DNS.

---

## Phase 0: Prerequisites

- [ ] SSH / FTP access to web server(s) for all 3 domains
- [ ] Ability to edit HTML `<head>` on `djtechnologies.in` and `djtechnologies.uk`
- [ ] Ability to add files to web root on `djtechnologies.net` (WHMCS)
- [ ] Google Search Console access (verify domain ownership)
- [ ] Google Analytics 4 account (create if none)
- [ ] Bing Webmaster Tools account

---

## Phase 1: Deploy robots.txt + Sitemaps (15 min)

### djtechnologies.in
1. Upload `07-robots-djtechnologies.in.txt` to `https://djtechnologies.in/robots.txt`
2. Upload `05-sitemap-djtechnologies.in.xml` to `https://djtechnologies.in/sitemap.xml`

### djtechnologies.uk
1. Upload `08-robots-djtechnologies.uk.txt` to `https://djtechnologies.uk/robots.txt`
2. Upload `06-sitemap-djtechnologies.uk.xml` to `https://djtechnologies.uk/sitemap.xml`

### djtechnologies.net
Already has robots.txt + sitemap. Enhance existing files:
- Append AI crawler rules from `07-robots-djtechnologies.in.txt` (User-agent: GPTBot etc.)
- Ensure sitemap includes all current pages

### Verify
```bash
curl -s https://djtechnologies.in/robots.txt | head -5
curl -s https://djtechnologies.in/sitemap.xml | head -5
```

---

## Phase 2: Inject JSON-LD Schema Markup (1 hour)

### For djtechnologies.in and djtechnologies.uk (SPA sites)

These sites are React SPAs. The schema must be injected server-side or via prerendering.

**Option A: Direct HTML injection (server-side)**
Edit the server template that serves `index.html`. Add ALL schema `<script type="application/ld+json">` blocks inside `<head>`:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Leading AI Automation & Technology Partner since 2018. Agentic AI, web development, mobile apps, hosting, and digital marketing solutions." />
  <meta property="og:title" content="DJ Technologies - AI Automation, Web Dev, Hosting & Digital Solutions" />
  <meta property="og:description" content="Leading AI Automation & Technology Partner since 2018. Agentic AI, web development, mobile apps, hosting, and digital marketing." />
  <meta property="og:image" content="https://djtechnologies.in/lovable-uploads/f73fa137-19cd-48ab-b80b-dd435c0b623c.png" />
  <meta property="og:url" content="https://djtechnologies.in/" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="DJ Technologies - AI Automation, Web Dev, Hosting & Digital Solutions" />
  <meta name="twitter:description" content="Leading AI Automation & Technology Partner since 2018." />
  <meta name="twitter:image" content="https://djtechnologies.in/lovable-uploads/f73fa137-19cd-48ab-b80b-dd435c0b623c.png" />
  <link rel="canonical" href="https://djtechnologies.in/" />

  <!-- Schema: Organization + LocalBusiness -->
  <script type="application/ld+json">
  [CONTENT OF 01-organization-localbusiness-schema.jsonld]
  </script>

  <!-- Schema: FAQPage -->
  <script type="application/ld+json">
  [CONTENT OF 02-faq-schema.jsonld]
  </script>

  <!-- Schema: Product/Service -->
  <script type="application/ld+json">
  [CONTENT OF 03-service-schema.jsonld]
  </script>

  <!-- Schema: BreadcrumbList + WebSite -->
  <script type="application/ld+json">
  [CONTENT OF 04-article-breadcrumb-schema.jsonld]
  </script>

  <!-- Schema: Comparison Table -->
  <script type="application/ld+json">
  [CONTENT OF 12-comparison-table-schema.jsonld]
  </script>

  <title>DJ Technologies - AI Automation, Web Dev, Hosting & Digital Solutions</title>
</head>
```

**Option B: Client-side injection (fallback)**
If you cannot edit the server template, inject via JavaScript in the SPA's entry point (`main.tsx` or equivalent). Note: AI crawlers may not execute JS, so Option A is strongly preferred.

```javascript
// Example: injectSchema.js
const schemas = [orgSchema, faqSchema, serviceSchema, breadcrumbSchema, comparisonSchema];
schemas.forEach(schema => {
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(schema);
  document.head.appendChild(script);
});
```

### For djtechnologies.net (WHMCS)

Add schema to the WHMCS header template:
1. Go to **System Settings → General Settings → Other → Head Output**
2. Or edit `templates/hostx-child/header.tpl` in WHMCS
3. Add Organization + LocalBusiness + FAQ schema
4. Service/product schema for hosting plans can go on respective product pages

---

## Phase 3: Deploy GA4 (30 min)

Follow `10-ga4-implementation-guide.md` fully.

---

## Phase 4: Submit to Search Engines (15 min)

### Google Search Console
1. Add each domain as a property
2. Verify via DNS TXT record or HTML file upload
3. Submit sitemaps:
   - `https://djtechnologies.in/sitemap.xml`
   - `https://djtechnologies.uk/sitemap.xml`
   - `https://djtechnologies.net/sitemap.xml`
4. Request manual indexing of homepage

### Bing Webmaster Tools
Same process — submit sitemaps

### Yandex Webmaster Tools
Same process for Russian market

---

## Phase 5: Address SPA Crawlability (1-2 days)

The biggest SEO gap is that `djtechnologies.in` and `.uk` are client-rendered SPAs.

### Minimum viable fix: Prerender
Use a prerendering service (e.g., Prerender.io, Rendertron, or a self-hosted Puppeteer):

1. Set up middleware on the web server:
   ```nginx
   # nginx example — detect bots, serve prerendered snapshots
   location / {
     if ($http_user_agent ~* "googlebot|bingbot|baiduspider|facebookexternalhit|twitterbot|rogerbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|slack|slack-im-bot|vkshare|w3c_validator|whatsapp|GPTBot|Claude-Web|ChatGPT-User|PerplexityBot|anthropic-ai") {
       proxy_pass http://prerender-service:3000;
       break;
     }
     proxy_pass http://node-app:3000;
   }
   ```

2. Prerender service caches fully-rendered HTML snapshots
3. Search engines and AI crawlers see real content

### Ideal fix: Add SSR
Migrate to Next.js or similar framework that renders React on the server.

---

## Phase 6: Verification Checklist

- [ ] `curl https://djtechnologies.in/robots.txt` → returns valid robots
- [ ] `curl https://djtechnologies.in/sitemap.xml` → valid XML sitemap
- [ ] `curl -s https://djtechnologies.in | grep "application/ld+json"` → schema blocks present
- [ ] `curl -s https://djtechnologies.in | grep "gtag"` → GA4 code present
- [ ] Google Search Console → sitemap indexed, no errors
- [ ] Rich Results Test → passes for FAQ, Product, Breadcrumb, Organization
- [ ] Mobile-Friendly Test → passes
- [ ] PageSpeed Insights → 80+ score
- [ ] GA4 Realtime → shows active session from test visit
