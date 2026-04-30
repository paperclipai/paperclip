---
schema: agentcompanies/v1
kind: team
slug: marketing
name: Marketing & SEO
description: SEO + GEO (Generative Engine Optimization) for the Academy. Continuous monitoring of Search Console + Lighthouse + GA4, schema.org JSON-LD, sitemap, /llms.txt, OG images. Phase 3+ adds Google Ads campaign management.
manager: ../../agents/chief-marketing/AGENTS.md
includes:
  - ../../agents/seo-optimizer/AGENTS.md
tags:
  - team
  - marketing
  - seo
  - geo
---

# Marketing & SEO team

Smallest team in V1: Chief Marketing + SEO Optimizer. Continuously monitors and improves discoverability — Google search ranking and AI-search citation.

## Workflow

```
Continuous (no fixed cron — heartbeat-driven):
  seo-optimizer reads Search Console + Lighthouse + GA4
  identifies opportunities
  ↓
  files improvement tickets to chief-marketing
  ↓
chief-marketing triages:
  ├── small fix (meta tag, schema.org tweak) → seo-optimizer implements directly → CEO G3 → Human G4
  └── needs code (new sitemap structure, new OG image route) → engineering team → harness flow
```

## What we monitor (V1)

- **Google Search Console** — indexed page count, CTR, top queries, coverage errors
- **Lighthouse** (via `@lhci/cli` cron) — Core Web Vitals (INP <200ms, LCP <2.5s, CLS <0.1) per page
- **GA4** (when connected) — page views, conversion (course-completion proxy), bounce rate
- **Bing Webmaster Tools** — secondary index check

## What we generate (V1)

- **schema.org JSON-LD** — `Course`, `FAQPage`, `HowTo`, `VideoObject`, `Article` on every page
- **Dynamic sitemap.xml** — auto-includes new courses, blogs
- **`/llms.txt`** + **`/llms-full.txt`** — machine-readable index of top URLs + markdown corpus export
- **Open Graph images** — auto-generated via Vercel OG per course
- **Robots.txt + canonical URLs**

## Why GEO matters

We want the Academy cited by AI search engines (ChatGPT search, Claude web, Perplexity, Gemini, You.com), not just Google. As of April 2026:
- llms.txt adoption is small (~7% Fortune 500) but supported by Anthropic, Cursor, Mintlify
- AI search engines extract from structured data (FAQ, HowTo, Course) heavily
- Answer-first headings ("How to use Claude in 5 steps", not "Claude Guide") outrank keyword-driven ones

## SpamBrain compliance

Google's March 2026 spam update penalises scaled unedited AI content. Our 5-gate publish pipeline (G0 Reviewer + G4 Human) satisfies the "augmented" criterion. SEO Optimizer never auto-publishes content; only meta + schema changes flow without manual approval.

## V2 additions

- Google Ads campaign agent (under Chief Marketing) — bid management, ad copy, A/B tests
- GA4 monitor agent — anomaly detection, opportunity flagging
- Content-gap analyzer — weekly competitor content scan
- llms.txt drift watcher — flags when our corpus diverges from indexed pages

## Out-of-bounds for V1

- Paid ad spend (manual until V2)
- Social media auto-posting (V3)
- Email marketing campaigns (V3 — beyond the existing Resend EOD digest)
