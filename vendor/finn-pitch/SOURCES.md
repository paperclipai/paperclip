# Content & Asset Provenance

finn-pitch is **standalone** — it runs from the committed `data/` + `assets/`
snapshot and needs nothing from hf-web-v2 at runtime.

To refresh when Finn's site content changes:

```bash
npm run sync -- --src ../hf-web-v2
git diff        # review
git commit -am "sync: refresh Finn content snapshot"
```

`lib/sync.mjs` esbuild-bundles each pure-data TS module (resolving `@/`,
stripping types, stubbing react/lucide/next), imports it, and writes JSON.
Assets are copied straight from `public/`.

## data/  ← hf-web-v2 source

| File | Source module | Exports pulled |
|------|---------------|----------------|
| plans.json | `lib/config/plans.ts` | PLANS, PHONE_NUMBER_PRICE(_INR) |
| human-cost.json | `lib/cost-model.ts` | REP_DAY_COST, DIALS/CONNECT rates… (human baseline) |
| finn-roi.json | `lib/roi-calc.ts` | MANUAL_COST_PER_CONNECT, BENCHMARK_PICKUP_RATE, AHT |
| testimonials.json | `lib/testimonials.ts` | TESTIMONIALS |
| industries.json | `lib/industries.ts` | INDUSTRIES, FEATURED, TAGS (icons dropped) |
| capabilities.json | `lib/platform.ts` | CAPABILITIES, CAPABILITY_PAGES, FEATURES… |
| playbooks.json | `lib/playbooks.ts` | PLAYBOOKS, PLAYBOOK_CATEGORIES |
| usecases.json | `lib/use-case-data.ts` | useCaseDataMap (agent personas/scripts) |
| usecase-templates.json | `lib/template-usecase-mappings.ts` | templateUseCaseMappings |
| voices.json | `lib/voice-catalog.ts` | VOICE_CATALOG |
| languages.json | `lib/language-catalog.ts` | POPULAR_LANGUAGE_CATALOG, FLAGS |
| pricing-faq.json | `lib/pricing-faq-data.ts` | pricingFaqData |
| billing.json | `lib/config/finn-billing.ts` | FINN_BILLING |
| taglines.json | `lib/seo/page-metadata.ts` | PAGE_SEO |
| **facts.md** | manifesto + platform + swivel-chair-tax + homepage | **hand-curated prose** (not auto-synced) |

## assets/  ← hf-web-v2 public/

| Dir | Source |
|-----|--------|
| snaps/ | `public/_static/snaps/*-light.html` (suffix stripped) |
| industry-hero/ | `public/_static/industry-hero/*` (22 vertical photos) |
| logos/ | `public/logos/*.svg` (36 integrations) |
| avatars/ | `public/_static/avatars/*` (agent persona faces) |
| customers/ | `public/_static/*/{frinks,orbit,snazzy,rocket,tofa,pillar}*.svg` |
| brand/ | `public/_static/marketing/assets/{finn-logo,finn-logotype,wave-1,wave-2,signature}.svg` + `public/assets/og-image.png` |

## ROI model (two sides)
- **Human baseline** — `human-cost.json` (from cost-model.ts / swivel-chair-tax): ₹2,800·$300/rep-day, 80 dials/day, 12% connect.
- **Finn side** — `cost-model.mjs` uses plan credit rate + 38% connect (3.2× uplift) from swivel-chair-tax.
- `finn-roi.json` (roi-calc.ts benchmarks) retained for reference.

## NOT synced (decided out of scope)
- blogs (`content/blog/*`) — SEO/thought-leadership, not pitch content.
